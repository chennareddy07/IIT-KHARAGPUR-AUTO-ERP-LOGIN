(() => {
if (globalThis.__iitkgpErpLoginContentLoaded) {
  return;
}
globalThis.__iitkgpErpLoginContentLoaded = true;

const ERP_SELECTORS = {
  form: "#loginForm",
  userId: "#user_id",
  password: "#password",
  questionContainer: "#answer_div",
  question: "#question",
  answer: "#answer",
  otp: "#email_otp1",
  sendOtp: "#getotp",
  submit: "#loginFormSubmitButton"
};

let otpStartedAt = null;
let loginFormPrepared = false;
let activeAutoAttemptId = null;
let fillSequence = 0;
let activeOtpSubmissionPromise = null;
let activeOtpSubmissionAttemptId = null;
let activePollDelay = null;
const consumedSendOtpAttempts = new Set();
const OTP_TIMEOUT_MS = 5 * 60 * 1000;
const OTP_POLL_INTERVAL_MS = 5000;

function logAutoLogin(attemptId, event, details = {}) {
  console.info("[ERP Login Assistant]", { attemptId, event, ...details });
}

function notifyAutoLoginProgress(phase, attemptId) {
  chrome.runtime.sendMessage({ type: "ERP_AUTO_LOGIN_PROGRESS", phase, attemptId }, () => {
    void chrome.runtime.lastError;
  });
}

function ensureAttemptActive(attemptId) {
  if (attemptId && activeAutoAttemptId !== attemptId) {
    throw new Error("This Auto Login attempt was cancelled or replaced.");
  }
}

function normalizeQuestion(value) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function isVisible(element) {
  if (!element) {
    return false;
  }
  const style = getComputedStyle(element);
  return style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0;
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  if (!setter) {
    throw new Error("Could not safely populate the ERP form.");
  }
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function detectExtraVerification() {
  const captchaSelectors = [
    'iframe[src*="captcha" i]',
    'iframe[title*="captcha" i]',
    ".g-recaptcha",
    "#captcha",
    'input[name*="captcha" i]'
  ];
  if (captchaSelectors.some((selector) => [...document.querySelectorAll(selector)].some(isVisible))) {
    return true;
  }
  return /captcha|robot verification|security key/i.test(document.body.innerText);
}

function waitForQuestion(timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const question = document.querySelector(ERP_SELECTORS.question);
    if (!question) {
      reject(new Error("The ERP security-question field was not found."));
      return;
    }
    const initial = question.textContent?.trim() || "";
    if (initial && isVisible(document.querySelector(ERP_SELECTORS.questionContainer))) {
      resolve(initial);
      return;
    }

    const observer = new MutationObserver(() => {
      const text = question.textContent?.trim() || "";
      if (text && isVisible(document.querySelector(ERP_SELECTORS.questionContainer))) {
        clearTimeout(timeout);
        observer.disconnect();
        resolve(text);
      }
    });
    observer.observe(question, { childList: true, subtree: true, characterData: true });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("ERP did not return a security question for this user ID."));
    }, timeoutMs);
  });
}

async function fillLoginForm(attemptId = null) {
  const sequence = ++fillSequence;
  loginFormPrepared = false;
  otpStartedAt = null;
  ensureAttemptActive(attemptId);
  if (detectExtraVerification()) {
    throw new Error("Additional verification is required. Please complete it manually.");
  }
  const form = document.querySelector(ERP_SELECTORS.form);
  const userId = document.querySelector(ERP_SELECTORS.userId);
  const password = document.querySelector(ERP_SELECTORS.password);
  const answer = document.querySelector(ERP_SELECTORS.answer);
  const questionContainer = document.querySelector(ERP_SELECTORS.questionContainer);
  const question = document.querySelector(ERP_SELECTORS.question);
  const sendOtp = document.querySelector(ERP_SELECTORS.sendOtp);
  if (!form || !userId || !password || !answer || !questionContainer || !question || !sendOtp) {
    throw new Error("This page does not match the supplied ERP login form.");
  }

  const { erpCredentials } = await chrome.storage.local.get("erpCredentials");
  if (!erpCredentials?.userId || !erpCredentials?.password) {
    throw new Error("Configure your ERP user ID and password in Settings first.");
  }
  if (!Array.isArray(erpCredentials.securityQuestions)) {
    throw new Error("Add your security questions and answers in Settings first.");
  }

  setInputValue(userId, erpCredentials.userId);
  setInputValue(password, erpCredentials.password);
  setInputValue(answer, "");
  question.textContent = "";
  questionContainer.classList.add("hidden");
  userId.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

  const displayedQuestion = await waitForQuestion();
  if (sequence !== fillSequence) {
    throw new Error("The ERP form fill was superseded by a newer attempt.");
  }
  ensureAttemptActive(attemptId);
  const normalizedDisplayed = normalizeQuestion(displayedQuestion);
  const match = erpCredentials.securityQuestions.find((item) =>
    item?.question &&
    item?.answer &&
    normalizeQuestion(item.question) === normalizedDisplayed
  );
  if (!match) {
    throw new Error("Security question was not recognized. Please check Settings.");
  }
  setInputValue(answer, match.answer);
  if (answer.value !== match.answer) {
    throw new Error("Could not verify the configured security answer in the ERP form.");
  }

  otpStartedAt = Date.now();
  loginFormPrepared = true;
  return {
    ok: true,
    message: `Credentials filled and security question matched: ${displayedQuestion}`
  };
}

function clickErpSendOtp(attemptId, baselineAt) {
  if (typeof attemptId !== "string" || !attemptId) {
    throw new Error("The Auto Login attempt ID is missing.");
  }
  ensureAttemptActive(attemptId);
  if (consumedSendOtpAttempts.has(attemptId)) {
    throw new Error("Send OTP was already requested for this Auto Login attempt.");
  }
  const userId = document.querySelector(ERP_SELECTORS.userId);
  const password = document.querySelector(ERP_SELECTORS.password);
  const answer = document.querySelector(ERP_SELECTORS.answer);
  const sendOtp = document.querySelector(ERP_SELECTORS.sendOtp);
  if (!loginFormPrepared || !userId?.value || !password?.value || !answer?.value) {
    throw new Error("Fill the ERP credentials and matching security answer before requesting OTP.");
  }
  if (!sendOtp || !isVisible(sendOtp) || sendOtp.disabled) {
    throw new Error("The ERP Send OTP button is not available.");
  }

  if (!Number.isFinite(baselineAt)) {
    throw new Error("The OTP email baseline was not set before requesting an OTP.");
  }
  consumedSendOtpAttempts.add(attemptId);
  if (consumedSendOtpAttempts.size > 200) {
    consumedSendOtpAttempts.delete(consumedSendOtpAttempts.values().next().value);
  }
  otpStartedAt = baselineAt;
  logAutoLogin(attemptId, "send_otp_clicked");
  sendOtp.click();
  return { ok: true };
}

function getOtpCheckFromBackground(startedAt, attemptId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "ERP_GET_GMAIL_OTP", startedAt, attemptId },
      (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error("Could not contact the Gmail OTP service."));
          return;
        }
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve({
          otp: response?.otp || null,
          diagnostics: response?.diagnostics || null
        });
      }
    );
  });
}

function delay(milliseconds, attemptId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      activePollDelay = null;
      resolve();
    }, milliseconds);
    activePollDelay = { attemptId, timer, resolve };
  });
}

function cancelActivePollDelay() {
  if (!activePollDelay) {
    return;
  }
  clearTimeout(activePollDelay.timer);
  const { resolve } = activePollDelay;
  activePollDelay = null;
  resolve();
}

async function waitForLatestOtp(startedAt, attemptId) {
  const deadline = Math.min(startedAt + OTP_TIMEOUT_MS, Date.now() + OTP_TIMEOUT_MS);
  let pollCount = 0;
  while (Date.now() < deadline) {
    ensureAttemptActive(attemptId);
    pollCount += 1;
    const result = await getOtpCheckFromBackground(startedAt, attemptId);
    ensureAttemptActive(attemptId);
    logAutoLogin(attemptId, "otp_poll_complete", {
      pollCount,
      found: Boolean(result.otp),
      gmailQueryResultCount: result.diagnostics?.gmailQueryResultCount,
      detailFetchedCount: result.diagnostics?.detailFetchedCount,
      missingPayloadCount: result.diagnostics?.missingPayloadCount,
      invalidTimestampCount: result.diagnostics?.invalidTimestampCount,
      olderThanBaselineCount: result.diagnostics?.olderThanBaselineCount,
      timestampInWindowCount: result.diagnostics?.timestampInWindowCount,
      erpBodyMarkerCount: result.diagnostics?.erpBodyMarkerCount,
      validOtpFormatCount: result.diagnostics?.validOtpFormatCount,
      newestCandidateAgeMs: result.diagnostics?.newestCandidateAgeMs
    });
    if (result.otp) {
      return result.otp;
    }
    const waitMs = Math.min(OTP_POLL_INTERVAL_MS, deadline - Date.now());
    if (waitMs > 0) {
      await delay(waitMs, attemptId);
    }
  }
  throw new Error("OTP was not received within the allowed time.");
}

async function runOtpSubmission(attemptId) {
  ensureAttemptActive(attemptId);
  if (detectExtraVerification()) {
    throw new Error("Additional verification is required. Please complete it manually.");
  }
  const form = document.querySelector(ERP_SELECTORS.form);
  const otpInput = document.querySelector(ERP_SELECTORS.otp);
  const submit = document.querySelector(ERP_SELECTORS.submit);
  if (!form || !otpInput || !submit) {
    throw new Error("The ERP sign-in form or OTP field is no longer available.");
  }

  if (!Number.isFinite(otpStartedAt)) {
    throw new Error("Fill the ERP login form first, then request an OTP.");
  }

  const startedAt = otpStartedAt;
  notifyAutoLoginProgress("OTP_EMAIL_POLLING", attemptId);
  logAutoLogin(attemptId, "otp_polling_started");
  const otp = await waitForLatestOtp(startedAt, attemptId);
  ensureAttemptActive(attemptId);
  notifyAutoLoginProgress("OTP_FOUND", attemptId);
  notifyAutoLoginProgress("FILLING_OTP", attemptId);
  setInputValue(otpInput, otp);
  if (otpInput.value !== otp) {
    throw new Error("Could not verify the OTP field value.");
  }
  otpStartedAt = null;
  notifyAutoLoginProgress("SUBMITTING_LOGIN", attemptId);
  logAutoLogin(attemptId, "otp_filled_and_login_submitted");
  submit.click();
  notifyAutoLoginProgress("VERIFY_LOGIN", attemptId);
  return {
    ok: true,
    message: "OTP entered and the ERP form was submitted. Check the ERP page for the sign-in result."
  };
}

function fetchOtpAndSubmit(attemptId = null) {
  if (activeOtpSubmissionPromise) {
    if (attemptId && activeAutoAttemptId === attemptId) {
      if (activeOtpSubmissionAttemptId === attemptId) {
        return activeOtpSubmissionPromise;
      }
    } else if (!attemptId && !activeOtpSubmissionAttemptId) {
      return activeOtpSubmissionPromise;
    } else if (!attemptId) {
      return Promise.reject(new Error("An Auto Login OTP submission is already running on this ERP tab."));
    }
  }
  const submission = runOtpSubmission(attemptId).finally(() => {
    if (activeOtpSubmissionPromise === submission) {
      activeOtpSubmissionPromise = null;
      activeOtpSubmissionAttemptId = null;
    }
  });
  activeOtpSubmissionPromise = submission;
  activeOtpSubmissionAttemptId = attemptId;
  return submission;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ERP_PING") {
    sendResponse({ ready: true });
    return false;
  }
  if (message?.type === "ERP_AUTO_LOGIN_CLICK_SEND_OTP") {
    try {
      sendResponse(clickErpSendOtp(message.attemptId, message.baselineAt));
    } catch (error) {
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Could not click ERP Send OTP."
      });
    }
    return false;
  }
  if (message?.type === "ERP_AUTO_LOGIN_START") {
    if (typeof message.attemptId !== "string") {
      sendResponse({ ok: false, message: "Auto Login attempt ID is invalid." });
      return false;
    }
    cancelActivePollDelay();
    activeAutoAttemptId = message.attemptId;
    otpStartedAt = null;
    loginFormPrepared = false;
    logAutoLogin(message.attemptId, "content_attempt_started");
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "ERP_AUTO_LOGIN_CANCEL") {
    if (message.attemptId === activeAutoAttemptId) {
      activeAutoAttemptId = null;
      otpStartedAt = null;
      loginFormPrepared = false;
      cancelActivePollDelay();
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "ERP_FILL_LOGIN") {
    fillLoginForm(message.attemptId || null)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Could not fill the ERP form."
      }));
    return true;
  }
  if (message?.type === "ERP_FETCH_OTP_AND_SUBMIT") {
    fetchOtpAndSubmit(message.attemptId || null)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : "Could not retrieve or submit the OTP."
      }));
    return true;
  }
  return false;
});
})();
