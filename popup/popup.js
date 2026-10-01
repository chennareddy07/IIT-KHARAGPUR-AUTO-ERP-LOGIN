const statusElement = document.querySelector("#status");
const accountStatus = document.querySelector("#accountStatus");
const questionStatus = document.querySelector("#questionStatus");
const gmailStatus = document.querySelector("#gmailStatus");
const connectButton = document.querySelector("#connectGmail");
const disconnectButton = document.querySelector("#disconnectGmail");
const startButton = document.querySelector("#startLogin");
const autoLoginButton = document.querySelector("#autoLogin");
const continueButton = document.querySelector("#continueLogin");
const tabDiagnostics = document.querySelector("#tabDiagnostics");
const closePanelButton = document.querySelector("#closePanel");
let autoLoginSubmitInitiated = false;
let loginOperationRunning = false;
let activeAutoLoginAttemptId = null;
let autoLoginState = "IDLE";

function setStatus(message) {
  statusElement.textContent = message;
  statusElement.classList.toggle("is-error", /failed|error|not recognized|not received|rejected|could not|please reconnect|not open/i.test(message));
  statusElement.classList.toggle("is-success", /login successful|settings saved/i.test(message));
}

function renderTabDiagnostics({ url = "Unavailable", hostMatches = false, pathMatches = false, contentScript = "Not checked" } = {}) {
  tabDiagnostics.textContent = [
    `Detected active tab URL: ${url}`,
    `ERP hostname matches: ${hostMatches ? "yes" : "no"}`,
    `ERP path matches: ${pathMatches ? "yes" : "no"}`,
    `Content script responded: ${contentScript}`
  ].join("\n");
}

function isSupportedErpLoginUrl(url) {
  return url.protocol === "https:" &&
    url.hostname === "erp.iitkgp.ac.in" &&
    (url.pathname.startsWith("/IIT_ERP3/") ||
      url.pathname === "/SSOAdministration/login.htm");
}

async function getActiveErpTab(errorMessage = "The active tab is not an HTTPS IIT Kharagpur ERP login page.") {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  let parsedUrl;
  try {
    parsedUrl = tab?.url ? new URL(tab.url) : null;
  } catch {
    parsedUrl = null;
  }

  const safeUrl = parsedUrl ? `${parsedUrl.origin}${parsedUrl.pathname}` : "Unavailable";
  const hostMatches = parsedUrl?.hostname === "erp.iitkgp.ac.in";
  const pathMatches = parsedUrl
    ? isSupportedErpLoginUrl(parsedUrl)
    : false;
  renderTabDiagnostics({ url: safeUrl, hostMatches, pathMatches });

  if (!tab?.id || !hostMatches || !pathMatches) {
    throw new Error(errorMessage);
  }
  return tab;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function setAutoLoginPhase(phase, attemptId = activeAutoLoginAttemptId) {
  if (attemptId !== activeAutoLoginAttemptId) {
    return;
  }
  const labels = {
    CHECK_ERP_PAGE: "Checking ERP page...",
    FILL_CREDENTIALS: "Filling ERP form...",
    CLICK_SEND_OTP: "Sending OTP...",
    WAIT_FOR_ERP_CONFIRMATION: "Waiting for ERP confirmation...",
    OTP_EMAIL_POLLING: "Waiting for OTP email...",
    OTP_RECEIVED: "OTP received. Signing in...",
    OTP_FOUND: "OTP received. Signing in...",
    FILLING_OTP: "OTP received. Signing in...",
    SUBMITTING_LOGIN: "OTP received. Signing in...",
    VERIFY_LOGIN: "Verifying login..."
  };
  setStatus(labels[phase] || "Auto Login is running...");
  progressPanel.hidden = false;
  const displayPhase = {
    OTP_FOUND: "OTP_RECEIVED",
    FILLING_OTP: "OTP_RECEIVED",
    SUBMITTING_LOGIN: "VERIFY_LOGIN"
  }[phase] || phase;
  const phases = [
    "CHECK_ERP_PAGE",
    "FILL_CREDENTIALS",
    "CLICK_SEND_OTP",
    "WAIT_FOR_ERP_CONFIRMATION",
    "OTP_EMAIL_POLLING",
    "OTP_RECEIVED",
    "VERIFY_LOGIN"
  ];
  const currentIndex = phases.indexOf(displayPhase);
  for (const [index, item] of [...progressSteps.querySelectorAll("[data-step]")].entries()) {
    item.classList.toggle("complete", index < currentIndex);
    item.classList.toggle("current", index === currentIndex);
  }
}

const AUTO_LOGIN_TRANSITIONS = {
  IDLE: ["VERIFYING_ERP"],
  VERIFYING_ERP: ["FILLING_CREDENTIALS"],
  FILLING_CREDENTIALS: ["REQUESTING_OTP"],
  REQUESTING_OTP: ["OTP_REQUESTED"],
  OTP_REQUESTED: ["WAITING_FOR_OTP"],
  WAITING_FOR_OTP: ["OTP_FOUND"],
  OTP_FOUND: ["FILLING_OTP"],
  FILLING_OTP: ["SUBMITTING_LOGIN"],
  SUBMITTING_LOGIN: ["VERIFY_LOGIN"],
  VERIFY_LOGIN: ["SUCCESS"]
};

function transitionAutoLoginState(attemptId, nextState) {
  if (attemptId !== activeAutoLoginAttemptId) {
    return false;
  }
  if (nextState === autoLoginState) {
    return true;
  }
  const terminal = ["SUCCESS", "ERROR", "CANCELLED"];
  const valid = terminal.includes(nextState)
    ? !terminal.includes(autoLoginState)
    : AUTO_LOGIN_TRANSITIONS[autoLoginState]?.includes(nextState) === true;
  if (!valid) {
    console.warn("[ERP Login Assistant] Ignored invalid Auto Login state transition.", {
      attemptId,
      from: autoLoginState,
      to: nextState
    });
    return false;
  }
  autoLoginState = nextState;
  console.info("[ERP Login Assistant] Auto Login state.", { attemptId, state: nextState });
  return true;
}

function setAutoLoginRunning(running) {
  setLoginButtonsBusy(running);
  connectButton.disabled = running;
  disconnectButton.disabled = running;
  document.querySelector("#openSettings").disabled = running;
  if (running) {
    progressPanel.hidden = false;
    for (const item of progressSteps.querySelectorAll("[data-step]")) {
      item.classList.remove("complete", "current");
    }
  }
}

function setLoginButtonsBusy(busy) {
  loginOperationRunning = busy;
  startButton.disabled = busy;
  autoLoginButton.disabled = busy;
  continueButton.disabled = busy;
}

function autoLoginErrorMessage(message) {
  if (/security question.*not configured|not recognized/i.test(message)) {
    return "Security question was not recognized. Please check Settings.";
  }
  if (/gmail.*(not authorized|authorization expired)|authorize gmail/i.test(message)) {
    return "Please reconnect Gmail.";
  }
  if (/otp.*(not found|not received|five minutes|five-minute|timeout)/i.test(message)) {
    return "OTP was not received within the allowed time.";
  }
  if (/security answer|answer mismatch/i.test(message)) {
    return "ERP rejected the security answer. Check the matching answer in Settings.";
  }
  return message;
}

const progressPanel = document.querySelector("#progressPanel");
const progressSteps = document.querySelector("#progressSteps");

closePanelButton.addEventListener("click", async () => {
  closePanelButton.disabled = true;
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (typeof currentWindow.id !== "number") {
      throw new Error("Could not identify this browser window.");
    }
    await chrome.sidePanel.close({ windowId: currentWindow.id });
  } catch {
    setStatus("Could not close the side panel. Use Chrome's close (X) control.");
  } finally {
    closePanelButton.disabled = false;
  }
});

function isMissingContentScriptError(error) {
  return /receiving end does not exist|could not establish connection/i.test(error.message);
}

async function getCurrentErpTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let url;
  try {
    url = tab.url ? new URL(tab.url) : null;
  } catch {
    url = null;
  }
  const supported = url ? isSupportedErpLoginUrl(url) : false;
  renderTabDiagnostics({
    url: url ? `${url.origin}${url.pathname}` : "Unavailable",
    hostMatches: url?.hostname === "erp.iitkgp.ac.in",
    pathMatches: supported
  });
  if (!supported) {
    throw new Error("The ERP tab navigated away from a supported login page.");
  }
  return tab;
}

async function ensureErpContentScript(tab) {
  let currentTab = await getCurrentErpTab(tab.id);
  renderTabDiagnostics({
    url: `${new URL(currentTab.url).origin}${new URL(currentTab.url).pathname}`,
    hostMatches: true,
    pathMatches: true,
    contentScript: "Checking..."
  });
  try {
    const response = await sendTabMessage(tab.id, { type: "ERP_PING" });
    if (response?.ready) {
      renderTabDiagnostics({
        url: `${new URL(currentTab.url).origin}${new URL(currentTab.url).pathname}`,
        hostMatches: true,
        pathMatches: true,
        contentScript: "yes"
      });
      return;
    }
  } catch (error) {
    if (!isMissingContentScriptError(error)) {
      renderTabDiagnostics({
        url: `${new URL(currentTab.url).origin}${new URL(currentTab.url).pathname}`,
        hostMatches: true,
        pathMatches: true,
        contentScript: "no (message failed)"
      });
      throw error;
    }
  }

  currentTab = await getCurrentErpTab(tab.id);
  renderTabDiagnostics({
    url: `${new URL(currentTab.url).origin}${new URL(currentTab.url).pathname}`,
    hostMatches: true,
    pathMatches: true,
    contentScript: "no; loading on this ERP tab..."
  });
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content/erp-login.js"]
    });
    const response = await sendTabMessage(tab.id, { type: "ERP_PING" });
    const responded = response?.ready === true;
    renderTabDiagnostics({
      url: `${new URL(currentTab.url).origin}${new URL(currentTab.url).pathname}`,
      hostMatches: true,
      pathMatches: true,
      contentScript: responded ? "yes (loaded now)" : "no"
    });
    if (!responded) {
      throw new Error("The ERP content script did not respond after being loaded.");
    }
  } catch (error) {
    renderTabDiagnostics({
      url: `${new URL(currentTab.url).origin}${new URL(currentTab.url).pathname}`,
      hostMatches: true,
      pathMatches: true,
      contentScript: "no (load or response failed)"
    });
    throw error;
  }
}

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message || "Gmail authorization failed."));
        return;
      }
      if (!token) {
        reject(new Error("Gmail authorization is required."));
        return;
      }
      resolve(token);
    });
  });
}

async function verifyGmailAccount() {
  const result = await chrome.runtime.sendMessage({ type: "ERP_VERIFY_GMAIL_ACCOUNT" });
  if (!result?.authorized) {
    throw new Error(result?.message || "Could not verify the authorized Gmail account.");
  }
  return result.message;
}

async function refreshConfigurationStatus() {
  const { erpCredentials } = await chrome.storage.local.get("erpCredentials");
  const credentials = erpCredentials || {};
  accountStatus.textContent = credentials.userId && credentials.password && credentials.emailAddress
    ? "ERP account: configured"
    : "ERP account: not configured";
  const configuredQuestions = Array.isArray(credentials.securityQuestions)
    ? credentials.securityQuestions.filter((item) => item.question && item.answer).length
    : 0;
  questionStatus.textContent = `Security questions: ${configuredQuestions} configured`;
  try {
    await getAuthToken(false);
    const message = await verifyGmailAccount();
    gmailStatus.textContent = message;
  } catch {
    gmailStatus.textContent = "Gmail: not authorized or mailbox mismatch";
  }
}

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  setStatus("Opening Google authorization...");
  try {
    await getAuthToken(true);
    const message = await verifyGmailAccount();
    gmailStatus.textContent = message;
    setStatus(`${message}.`);
  } catch (error) {
    gmailStatus.textContent = "Gmail: not authorized";
    setStatus(error instanceof Error
      ? error.message
      : "Gmail authorization failed. Check the OAuth setup and try again.");
  } finally {
    connectButton.disabled = false;
  }
});

disconnectButton.addEventListener("click", () => {
  disconnectButton.disabled = true;
  chrome.identity.clearAllCachedAuthTokens(() => {
    const error = chrome.runtime.lastError;
    if (error) {
      setStatus("Could not disconnect Gmail. Try again.");
    } else {
      chrome.runtime.sendMessage({ type: "ERP_CLEAR_GMAIL_AUTH_CACHE" }, () => {
        const cacheError = chrome.runtime.lastError;
        if (cacheError) {
          setStatus("Gmail token was cleared, but its temporary account-check cache could not be reset. Reload the extension.");
          return;
        }
        gmailStatus.textContent = "Gmail: not authorized";
        setStatus("The cached Gmail token was cleared. Revoke the app's Google access separately to fully disconnect.");
      });
    }
    disconnectButton.disabled = false;
  });
});

startButton.addEventListener("click", async () => {
  if (loginOperationRunning) {
    return;
  }
  setLoginButtonsBusy(true);
  setStatus("Filling the ERP login form...");
  try {
    const tab = await getActiveErpTab();
    await ensureErpContentScript(tab);
    const result = await sendTabMessage(tab.id, { type: "ERP_FILL_LOGIN" });
    setStatus(result?.message || "ERP form was filled. Review it before requesting the OTP.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not fill the ERP login form.");
  } finally {
    setLoginButtonsBusy(false);
  }
});

autoLoginButton.addEventListener("click", async () => {
  if (loginOperationRunning) {
    return;
  }
  const attemptId = crypto.randomUUID();
  activeAutoLoginAttemptId = attemptId;
  autoLoginState = "IDLE";
  transitionAutoLoginState(attemptId, "VERIFYING_ERP");
  setAutoLoginRunning(true);
  autoLoginSubmitInitiated = false;
  let tabId;
  try {
    setAutoLoginPhase("CHECK_ERP_PAGE", attemptId);
    const tab = await getActiveErpTab("Please open the IIT Kharagpur ERP website first.");
    tabId = tab.id;

    try {
      await getAuthToken(false);
      await verifyGmailAccount();
    } catch {
      throw new Error("Please reconnect Gmail.");
    }

    await ensureErpContentScript(tab);
    const beginResult = await sendRuntimeMessage({
      type: "ERP_AUTO_LOGIN_BEGIN",
      tabId,
      attemptId,
      baselineAt: Date.now()
    });
    if (!beginResult?.ok) {
      throw new Error(beginResult?.message || "Could not start an Auto Login attempt.");
    }
    const contentStart = await sendTabMessage(tabId, {
      type: "ERP_AUTO_LOGIN_START",
      attemptId
    });
    if (!contentStart?.ok) {
      throw new Error(contentStart?.message || "Could not prepare the ERP tab for Auto Login.");
    }

    transitionAutoLoginState(attemptId, "FILLING_CREDENTIALS");
    setAutoLoginPhase("FILL_CREDENTIALS", attemptId);
    const fillResult = await sendTabMessage(tabId, {
      type: "ERP_FILL_LOGIN",
      attemptId
    });
    if (!fillResult?.ok) {
      throw new Error(fillResult?.message || "Could not fill the ERP login form.");
    }

    transitionAutoLoginState(attemptId, "REQUESTING_OTP");
    const baselineAt = Date.now();
    const otpSendResult = await sendRuntimeMessage({
      type: "ERP_AUTO_LOGIN_SEND_OTP",
      tabId,
      attemptId,
      baselineAt
    });
    if (!otpSendResult?.confirmed) {
      throw new Error(otpSendResult?.message || "ERP did not confirm that the OTP was sent.");
    }

    transitionAutoLoginState(attemptId, "OTP_REQUESTED");
    transitionAutoLoginState(attemptId, "WAITING_FOR_OTP");
    setAutoLoginPhase("OTP_EMAIL_POLLING", attemptId);
    let submitResult;
    try {
      submitResult = await sendTabMessage(tabId, {
        type: "ERP_FETCH_OTP_AND_SUBMIT",
        attemptId
      });
    } catch (error) {
      if (!autoLoginSubmitInitiated) {
        throw error;
      }
    }
    if (!submitResult?.ok) {
      if (!autoLoginSubmitInitiated) {
        throw new Error(submitResult?.message || "Could not submit the ERP OTP.");
      }
    }

    setAutoLoginPhase("VERIFY_LOGIN", attemptId);
    const loginOutcome = await waitForLoginOutcome(tabId, attemptId);
    if (loginOutcome.result === "success") {
      transitionAutoLoginState(attemptId, "SUCCESS");
      setStatus("Login successful.");
    } else if (loginOutcome.result === "rejected") {
      transitionAutoLoginState(attemptId, "ERROR");
      setStatus("OTP was rejected. Please try again.");
    } else {
      transitionAutoLoginState(attemptId, "ERROR");
      setStatus("OTP was submitted, but ERP sign-in could not be verified automatically. Check the ERP page.");
    }
  } catch (error) {
    transitionAutoLoginState(attemptId, "ERROR");
    setStatus(autoLoginErrorMessage(error instanceof Error
      ? error.message
      : "Auto Login failed."));
  } finally {
    if (tabId !== undefined) {
      const cleanup = [
        sendRuntimeMessage({
          type: "ERP_AUTO_LOGIN_CANCEL",
          tabId,
          attemptId,
          completed: autoLoginState === "SUCCESS"
        }),
        sendTabMessage(tabId, { type: "ERP_AUTO_LOGIN_CANCEL", attemptId })
      ];
      const results = await Promise.allSettled(cleanup);
      if (results.some((result) => result.status === "rejected")) {
        console.info("[ERP Login Assistant] Auto Login cleanup was incomplete.", { attemptId });
      }
    }
    setAutoLoginRunning(false);
    if (/login successful/i.test(statusElement.textContent)) {
      for (const item of progressSteps.querySelectorAll("[data-step]")) {
        item.classList.remove("current");
        item.classList.add("complete");
      }
    } else {
      for (const item of progressSteps.querySelectorAll("[data-step]")) {
        item.classList.remove("current");
      }
    }
    if (activeAutoLoginAttemptId === attemptId) {
      activeAutoLoginAttemptId = null;
    }
  }
});

async function waitForLoginOutcome(tabId, attemptId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = null;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    let currentUrl;
    try {
      currentUrl = tab.url ? new URL(tab.url) : null;
    } catch {
      currentUrl = null;
    }
    if (currentUrl?.protocol !== "https:" ||
        currentUrl.hostname !== "erp.iitkgp.ac.in" ||
        !(currentUrl.pathname.startsWith("/IIT_ERP3/") ||
          currentUrl.pathname.startsWith("/SSOAdministration/"))) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (tab.status === "loading") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const path = location.pathname.toLowerCase();
        const text = document.body?.innerText || "";
        const loginFormPresent = Boolean(document.querySelector("#loginForm"));
        const loginFieldsPresent = Boolean(
          document.querySelector("#user_id, #password, #email_otp1, #getotp")
        );
        const visibleLogoutControl = [
          ...document.querySelectorAll(
            'a[href*="logout" i], form[action*="logout" i], button[name*="logout" i], a[href*="signout" i], a[href*="sign-out" i]'
          )
        ].some((element) =>
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden" &&
          getComputedStyle(element).display !== "none"
        );
        const successRoute = path === "/iit_erp3/showmenu.htm";
        const authenticatedPage =
          !loginFormPresent &&
          !loginFieldsPresent &&
          visibleLogoutControl;
        const otpRejected =
          /\botp\b.{0,60}\b(?:invalid|incorrect|expired|wrong|rejected)\b|\b(?:invalid|incorrect|expired|wrong|rejected)\b.{0,60}\botp\b/i.test(text);
        return {
          path,
          success: successRoute || authenticatedPage,
          evidence: successRoute ? "known_success_route" : authenticatedPage ? "logout_control_without_login_form" : "none",
          loginFormPresent,
          loginFieldsPresent,
          visibleLogoutControl,
          otpRejected
        };
      }
    });
    lastProbe = injection?.result || null;
    if (lastProbe?.success) {
      console.info("[ERP Login Assistant]", {
        attemptId,
        event: "login_success_detected",
        path: lastProbe.path,
        evidence: lastProbe.evidence
      });
      return { result: "success", path: lastProbe.path };
    }
    if (lastProbe?.otpRejected) {
      console.info("[ERP Login Assistant]", {
        attemptId,
        event: "otp_rejection_detected",
        path: lastProbe.path
      });
      return { result: "rejected", path: lastProbe.path };
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  console.info("[ERP Login Assistant]", {
    attemptId,
    event: "login_outcome_unverified",
    path: lastProbe?.path || null,
    loginFormPresent: lastProbe?.loginFormPresent ?? null,
    loginFieldsPresent: lastProbe?.loginFieldsPresent ?? null,
    visibleLogoutControl: lastProbe?.visibleLogoutControl ?? null
  });
  return { result: "unknown", path: lastProbe?.path || null };
}

chrome.runtime.onMessage.addListener((message) => {
  if (activeAutoLoginAttemptId &&
      message?.type === "ERP_AUTO_LOGIN_PROGRESS" &&
      message.attemptId === activeAutoLoginAttemptId) {
    if (message.phase === "OTP_FOUND") {
      transitionAutoLoginState(message.attemptId, "OTP_FOUND");
    } else if (message.phase === "FILLING_OTP") {
      transitionAutoLoginState(message.attemptId, "FILLING_OTP");
    } else if (message.phase === "SUBMITTING_LOGIN") {
      transitionAutoLoginState(message.attemptId, "SUBMITTING_LOGIN");
      autoLoginSubmitInitiated = true;
    } else if (message.phase === "VERIFY_LOGIN") {
      transitionAutoLoginState(message.attemptId, "VERIFY_LOGIN");
    }
    setAutoLoginPhase(message.phase, message.attemptId);
  }
});

continueButton.addEventListener("click", async () => {
  if (loginOperationRunning) {
    return;
  }
  setLoginButtonsBusy(true);
  setStatus("Checking Gmail for a new ERP sign-in OTP...");
  try {
    await getAuthToken(false);
    const verification = await verifyGmailAccount();
    gmailStatus.textContent = verification;
    const tab = await getActiveErpTab();
    await ensureErpContentScript(tab);
    const result = await sendTabMessage(tab.id, {
      type: "ERP_FETCH_OTP_AND_SUBMIT"
    });
    setStatus(result?.message || "The ERP form was submitted. Review the result on the ERP page.");
  } catch (error) {
    setStatus(error.message || "Could not retrieve or submit the OTP.");
  } finally {
    setLoginButtonsBusy(false);
  }
});

document.querySelector("#openSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refreshConfigurationStatus().catch(() => {
  setStatus("Could not read extension settings.");
});
