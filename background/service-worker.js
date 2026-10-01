const ERP_OTP_DIALOG_TIMEOUT_MS = 30000;
const OTP_TIMESTAMP_TOLERANCE_MS = 15000;
const activeOtpSearches = new Map();
const otpSearchControllers = new Map();
const autoOtpRequestPromises = new Map();
const autoOtpRequestResults = new Map();
const activeAutoAttemptsByTab = new Map();
const activeOtpDialogWaiters = new Map();
let verifiedGmailAuthorization = null;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error("ERP Login Assistant could not configure toolbar side-panel behavior.", error);
});

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function collectMessageText(payload) {
  const segments = [];
  function visit(part) {
    if (part.body?.data) {
      segments.push(decodeBase64Url(part.body.data));
    }
    for (const child of part.parts || []) {
      visit(child);
    }
  }
  visit(payload);
  return segments.join("\n");
}

function extractOtp(text) {
  const normalized = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
  const match = normalized.match(
    /OTP\s+for\s+Sign\s+In\s+in\s+ERP\s+Portal\s+of\s+IIT\s+Kharagpur\s+is\s*[:\-]?\s*(\d{4,8})\b/i
  );
  return match?.[1] || null;
}

function hasErpOtpMarker(text) {
  const normalized = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
  return /OTP\s+for\s+Sign\s+In\s+in\s+ERP\s+Portal\s+of\s+IIT\s+Kharagpur/i.test(normalized);
}

function getCachedAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      const error = chrome.runtime.lastError;
      if (error || !token) {
        reject(new Error("Gmail is not authorized. Authorize Gmail and try again."));
        return;
      }
      resolve(token);
    });
  });
}

async function fetchJson(url, accessToken, signal) {
  if (signal?.aborted) {
    throw new Error("The OTP search was cancelled.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const abortFromAttempt = () => controller.abort();
  signal?.addEventListener("abort", abortFromAttempt, { once: true });
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromAttempt);
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Gmail authorization expired. Reauthorize Gmail and try again.");
    }
    throw new Error("Gmail could not be searched. Check authorization and network access.");
  }
  return response.json();
}

async function verifyGmailAccount(accessToken) {
  const { erpCredentials } = await chrome.storage.local.get("erpCredentials");
  const expectedEmail = erpCredentials?.emailAddress?.trim().toLowerCase();
  if (!expectedEmail) {
    throw new Error("Set the Gmail address that receives ERP OTPs in Settings.");
  }
  if (verifiedGmailAuthorization?.token === accessToken &&
      verifiedGmailAuthorization.email === expectedEmail) {
    return "Gmail: authorized mailbox matched";
  }
  const profile = await fetchJson(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    accessToken
  );
  if (typeof profile.emailAddress !== "string" ||
      profile.emailAddress.toLowerCase() !== expectedEmail) {
    throw new Error("The authorized Gmail account does not match the mailbox configured in Settings. Use the Chrome profile for the mailbox receiving ERP OTPs.");
  }
  verifiedGmailAuthorization = { token: accessToken, email: expectedEmail };
  return "Gmail: authorized mailbox matched";
}

function logOtpDiagnostic(attemptId, event, details = {}) {
  console.info("[ERP Login Assistant]", { attemptId, event, ...details });
}

async function findRecentErpOtp(startedAt, attemptId, signal) {
  const accessToken = await getCachedAuthToken();
  await verifyGmailAccount(accessToken);
  if (signal.aborted) {
    return null;
  }

  const afterSeconds = Math.max(
    0,
    Math.floor((startedAt - OTP_TIMESTAMP_TOLERANCE_MS) / 1000) - 1
  );
  const query = encodeURIComponent(
    `after:${afterSeconds} OTP`
  );
  const list = await fetchJson(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${query}`,
    accessToken,
    signal
  );
  const listedMessages = list.messages || [];
  const details = await Promise.all(listedMessages
    .filter((message) => message.id)
    .map(async (message) => {
      return fetchJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`,
        accessToken,
        signal
      );
    }));
  const datedMessages = details
    .map((detail) => ({
      detail,
      receivedAt: Number(detail.internalDate)
    }))
    .filter(({ detail, receivedAt }) =>
      Number.isFinite(receivedAt)
    )
    .sort((left, right) => right.receivedAt - left.receivedAt);

  let missingPayloadCount = 0;
  let invalidTimestampCount = details.length - datedMessages.length;
  let olderThanBaselineCount = 0;
  let inWindowMessageCount = 0;
  let erpMarkerCount = 0;
  let otpFormatMatchCount = 0;
  let newestCandidateAgeMs = null;

  for (const { detail, receivedAt } of datedMessages) {
    const ageMs = receivedAt - startedAt;
    if (newestCandidateAgeMs === null) {
      newestCandidateAgeMs = ageMs;
    }
    if (ageMs < -OTP_TIMESTAMP_TOLERANCE_MS) {
      olderThanBaselineCount += 1;
      continue;
    }
    inWindowMessageCount += 1;
    if (!detail.payload) {
      missingPayloadCount += 1;
      continue;
    }
    const bodyText = collectMessageText(detail.payload);
    const erpMarkerFound = hasErpOtpMarker(bodyText);
    if (!erpMarkerFound) {
      continue;
    }
    erpMarkerCount += 1;
    const otp = extractOtp(bodyText);
    if (otp) {
      otpFormatMatchCount += 1;
      logOtpDiagnostic(attemptId, "gmail_search_complete", {
        gmailQueryResultCount: listedMessages.length,
        detailFetchedCount: details.length,
        missingPayloadCount,
        invalidTimestampCount,
        olderThanBaselineCount,
        timestampInWindowCount: inWindowMessageCount,
        erpBodyMarkerCount: erpMarkerCount,
        validOtpFormatCount: otpFormatMatchCount,
        newestCandidateAgeMs
      });
      logOtpDiagnostic(attemptId, "otp_email_matched", { receivedAt });
      return {
        otp,
        diagnostics: {
          gmailQueryResultCount: listedMessages.length,
          detailFetchedCount: details.length,
          missingPayloadCount,
          invalidTimestampCount,
          olderThanBaselineCount,
          timestampInWindowCount: inWindowMessageCount,
          erpBodyMarkerCount: erpMarkerCount,
          validOtpFormatCount: otpFormatMatchCount,
          newestCandidateAgeMs
        }
      };
    }
  }
  const diagnostics = {
    gmailQueryResultCount: listedMessages.length,
    detailFetchedCount: details.length,
    missingPayloadCount,
    invalidTimestampCount,
    olderThanBaselineCount,
    timestampInWindowCount: inWindowMessageCount,
    erpBodyMarkerCount: erpMarkerCount,
    validOtpFormatCount: otpFormatMatchCount,
    newestCandidateAgeMs
  };
  logOtpDiagnostic(attemptId, "gmail_search_complete", diagnostics);
  return { otp: null, diagnostics };
}

function checkForOtpOnce(startedAt, attemptId) {
  if (attemptId && activeOtpSearches.has(attemptId)) {
    return activeOtpSearches.get(attemptId);
  }

  const controller = new AbortController();
  if (attemptId) {
    otpSearchControllers.set(attemptId, controller);
  }
  const search = findRecentErpOtp(startedAt, attemptId, controller.signal)
    .finally(() => {
      if (attemptId) {
        if (activeOtpSearches.get(attemptId) === search) {
          activeOtpSearches.delete(attemptId);
        }
        if (otpSearchControllers.get(attemptId) === controller) {
          otpSearchControllers.delete(attemptId);
        }
      }
    });
  if (attemptId) {
    activeOtpSearches.set(attemptId, search);
  }
  return search;
}

function sendDebuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, "1.3", () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error("Chrome could not attach to the ERP tab to handle its OTP alert. Check the debugger permission and close DevTools if it is attached."));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error("Chrome could not detach from the ERP tab after handling its OTP alert."));
        return;
      }
      resolve();
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error("The ERP page did not respond to the Auto Login request."));
        return;
      }
      resolve(response);
    });
  });
}

function sendAutoLoginPhase(phase, attemptId) {
  chrome.runtime.sendMessage({ type: "ERP_AUTO_LOGIN_PROGRESS", phase, attemptId }, () => {
    void chrome.runtime.lastError;
  });
}

function waitForOtpSentDialog(target) {
  let cancelWait;
  const promise = new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      finish(() => reject(new Error("ERP did not show an OTP-sent confirmation alert.")));
    }, ERP_OTP_DIALOG_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    }

    function finish(callback) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    }

    cancelWait = () => finish(() => reject(new Error("ERP OTP alert wait was cancelled.")));

    function onDebuggerEvent(source, method, params) {
      if (source.tabId !== target.tabId || method !== "Page.javascriptDialogOpening") {
        return;
      }
      const isOtpSentConfirmation =
        params.type === "alert" &&
        /\botp\b/i.test(params.message || "") &&
        /\bsent\b/i.test(params.message || "") &&
        !/\botp\b.{0,40}\b(?:not|never|failed|unable|could not)\b.{0,20}\bsent\b/i.test(params.message || "");
      const isSecurityAnswerMismatch =
        params.type === "alert" &&
        /unable to send otp/i.test(params.message || "") &&
        /security question/i.test(params.message || "") &&
        /answer.{0,20}mismatch/i.test(params.message || "");

      if (!isOtpSentConfirmation) {
        if (isSecurityAnswerMismatch) {
          cleanup();
          chrome.debugger.sendCommand(
            target,
            "Page.handleJavaScriptDialog",
            { accept: true },
            () => {
              const error = chrome.runtime.lastError;
              if (error) {
                finish(() => reject(new Error("Chrome could not dismiss ERP's security-answer rejection alert.")));
                return;
              }
              finish(() => resolve({
                confirmed: false,
                message: "ERP rejected the security answer. Check the configured answer in Settings."
              }));
            }
          );
          return;
        }
        finish(() => resolve({
            confirmed: false,
            message: "ERP showed an alert that did not confirm the OTP was sent. Review and dismiss it manually."
          }));
        return;
      }

      cleanup();
      chrome.debugger.sendCommand(
        target,
        "Page.handleJavaScriptDialog",
        { accept: true },
        () => {
          const error = chrome.runtime.lastError;
          if (error) {
            finish(() => reject(new Error("Chrome could not accept the ERP OTP confirmation alert.")));
            return;
          }
          finish(() => resolve({ confirmed: true, confirmedAt: Date.now() }));
        }
      );
    }

    chrome.debugger.onEvent.addListener(onDebuggerEvent);
  });
  return {
    promise,
    cancel: () => cancelWait?.()
  };
}

async function autoRequestErpOtp(tabId, attemptId, baselineAt) {
  function ensureAttemptActive() {
    if (activeAutoAttemptsByTab.get(tabId) !== attemptId) {
      throw new Error("This Auto Login attempt was cancelled or replaced.");
    }
  }

  const tab = await chrome.tabs.get(tabId);
  let url;
  try {
    url = tab.url ? new URL(tab.url) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" ||
      url.hostname !== "erp.iitkgp.ac.in" ||
      !(url.pathname.startsWith("/IIT_ERP3/") ||
        url.pathname === "/SSOAdministration/login.htm")) {
    throw new Error("Please open the IIT Kharagpur ERP website first.");
  }

  const target = { tabId };
  await attachDebugger(target);
  try {
    ensureAttemptActive();
    await sendDebuggerCommand(target, "Page.enable");
    ensureAttemptActive();
    const dialogWaiter = waitForOtpSentDialog(target);
    activeOtpDialogWaiters.set(attemptId, dialogWaiter);
    sendAutoLoginPhase("CLICK_SEND_OTP", attemptId);
    const clickResult = await sendTabMessage(tabId, {
      type: "ERP_AUTO_LOGIN_CLICK_SEND_OTP",
      attemptId,
      baselineAt
    });
    if (!clickResult?.ok) {
      dialogWaiter.cancel();
      await dialogWaiter.promise.catch(() => {});
      throw new Error(clickResult?.message || "Could not click ERP Send OTP.");
    }
    ensureAttemptActive();
    sendAutoLoginPhase("WAIT_FOR_ERP_CONFIRMATION", attemptId);
    logOtpDiagnostic(attemptId, "erp_otp_request_clicked");
    return await dialogWaiter.promise;
  } catch (error) {
    throw error;
  } finally {
    activeOtpDialogWaiters.delete(attemptId);
    await detachDebugger(target);
  }
}

function rememberAutoOtpRequest(key, result) {
  autoOtpRequestResults.set(key, result);
  while (autoOtpRequestResults.size > 100) {
    autoOtpRequestResults.delete(autoOtpRequestResults.keys().next().value);
  }
}

function requestErpOtpOnce(tabId, attemptId, baselineAt) {
  const key = `${tabId}:${attemptId}`;
  if (autoOtpRequestResults.has(key)) {
    return Promise.resolve(autoOtpRequestResults.get(key));
  }
  const existing = autoOtpRequestPromises.get(key);
  if (existing) {
    return existing;
  }

  const request = autoRequestErpOtp(tabId, attemptId, baselineAt)
    .then((result) => {
      rememberAutoOtpRequest(key, result);
      return result;
    })
    .catch((error) => {
      const result = {
        confirmed: false,
        message: error instanceof Error ? error.message : "Could not request ERP OTP."
      };
      rememberAutoOtpRequest(key, result);
      return result;
    })
    .finally(() => autoOtpRequestPromises.delete(key));
  autoOtpRequestPromises.set(key, request);
  return request;
}

function cancelAutoLoginAttempt(tabId, attemptId, completed = false) {
  if (activeAutoAttemptsByTab.get(tabId) !== attemptId) {
    return false;
  }
  activeAutoAttemptsByTab.delete(tabId);
  otpSearchControllers.get(attemptId)?.abort();
  activeOtpDialogWaiters.get(attemptId)?.cancel();
  activeOtpDialogWaiters.delete(attemptId);
  logOtpDiagnostic(attemptId, completed ? "attempt_finished" : "attempt_cancelled");
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ERP_CLEAR_GMAIL_AUTH_CACHE") {
    verifiedGmailAuthorization = null;
    sendResponse({ cleared: true });
    return false;
  }

  if (message?.type === "ERP_AUTO_LOGIN_BEGIN") {
    if (!Number.isInteger(message.tabId) ||
        typeof message.attemptId !== "string" ||
        !Number.isFinite(message.baselineAt)) {
      sendResponse({ ok: false, message: "Auto Login attempt details are invalid." });
      return false;
    }
    const previousAttempt = activeAutoAttemptsByTab.get(message.tabId);
    if (previousAttempt && previousAttempt !== message.attemptId) {
      cancelAutoLoginAttempt(message.tabId, previousAttempt);
    }
    const previousRequest = previousAttempt
      ? autoOtpRequestPromises.get(`${message.tabId}:${previousAttempt}`)
      : null;
    Promise.resolve(previousRequest).then(() => {
      activeAutoAttemptsByTab.set(message.tabId, message.attemptId);
      logOtpDiagnostic(message.attemptId, "attempt_started");
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "ERP_AUTO_LOGIN_CANCEL") {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;
    const cancelled = Number.isInteger(tabId)
      ? cancelAutoLoginAttempt(tabId, message.attemptId, message.completed === true)
      : false;
    sendResponse({ cancelled });
    return false;
  }

  if (message?.type === "ERP_AUTO_LOGIN_SEND_OTP") {
    if (!Number.isInteger(message.tabId) ||
        typeof message.attemptId !== "string" ||
        !Number.isFinite(message.baselineAt) ||
        activeAutoAttemptsByTab.get(message.tabId) !== message.attemptId) {
      sendResponse({ confirmed: false, message: "The ERP tab could not be identified." });
      return false;
    }
    requestErpOtpOnce(message.tabId, message.attemptId, message.baselineAt)
      .then(sendResponse);
    return true;
  }

  if (message?.type === "ERP_VERIFY_GMAIL_ACCOUNT") {
    getCachedAuthToken()
      .then(verifyGmailAccount)
      .then((status) => sendResponse({ authorized: true, message: status }))
      .catch((error) => sendResponse({
        authorized: false,
        message: error instanceof Error ? error.message : "Gmail account verification failed."
      }));
    return true;
  }

  if (message?.type !== "ERP_GET_GMAIL_OTP") {
    return false;
  }

  if (!Number.isFinite(message.startedAt)) {
    sendResponse({ error: "The OTP request time is missing. Fill the login form again." });
    return false;
  }

  const senderTabId = sender.tab?.id;
  if (message.attemptId &&
      (!Number.isInteger(senderTabId) ||
       activeAutoAttemptsByTab.get(senderTabId) !== message.attemptId)) {
    sendResponse({ error: "This Auto Login attempt is no longer active." });
    return false;
  }

  checkForOtpOnce(message.startedAt, message.attemptId)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      error: error instanceof Error ? error.message : "Gmail OTP retrieval failed."
    }));
  return true;
});
