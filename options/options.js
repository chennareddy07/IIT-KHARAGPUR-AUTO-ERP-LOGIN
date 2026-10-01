const form = document.querySelector("#settingsForm");
const rowsContainer = document.querySelector("#questionRows");
const statusElement = document.querySelector("#status");
const gmailStatus = document.querySelector("#gmailStatus");
const authorizeGmailButton = document.querySelector("#authorizeGmail");
const disconnectGmailButton = document.querySelector("#disconnectGmail");

function setFeedback(message, type = "") {
  statusElement.textContent = message;
  statusElement.classList.toggle("is-error", type === "error");
  statusElement.classList.toggle("is-success", type === "success");
}

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error("Google authorization could not be completed."));
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

function createQuestionRow(index, question = "", answer = "") {
  const row = document.createElement("div");
  row.className = "question-row";

  const questionLabel = document.createElement("label");
  questionLabel.htmlFor = `question-${index}`;
  questionLabel.textContent = `Question ${index + 1}`;

  const questionInput = document.createElement("input");
  questionInput.id = `question-${index}`;
  questionInput.name = "securityQuestion";
  questionInput.value = question;
  questionInput.autocomplete = "off";

  const answerLabel = document.createElement("label");
  answerLabel.htmlFor = `answer-${index}`;
  answerLabel.textContent = `Answer ${index + 1}`;

  const answerInput = document.createElement("input");
  answerInput.id = `answer-${index}`;
  answerInput.name = "securityAnswer";
  answerInput.type = "password";
  answerInput.value = answer;
  answerInput.autocomplete = "off";

  const answerControl = document.createElement("div");
  answerControl.className = "input-with-action";
  const answerToggle = document.createElement("button");
  answerToggle.type = "button";
  answerToggle.className = "visibility-toggle";
  answerToggle.dataset.toggleInput = answerInput.id;
  answerToggle.textContent = "Show";
  answerToggle.setAttribute("aria-pressed", "false");
  answerControl.append(answerInput, answerToggle);

  row.append(questionLabel, questionInput, answerLabel, answerControl);
  return row;
}

async function loadSettings() {
  const { erpCredentials } = await chrome.storage.local.get("erpCredentials");
  const credentials = erpCredentials || {};
  document.querySelector("#userId").value = credentials.userId || "";
  document.querySelector("#password").value = credentials.password || "";
  document.querySelector("#emailAddress").value = credentials.emailAddress || "";
  const questions = Array.isArray(credentials.securityQuestions)
    ? credentials.securityQuestions
    : [];

  for (let index = 0; index < 3; index += 1) {
    const item = questions[index] || {};
    rowsContainer.append(createQuestionRow(index, item.question || "", item.answer || ""));
  }
}

function toggleSecretInput(toggle) {
  const input = document.getElementById(toggle.dataset.toggleInput);
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const showing = input.type === "password";
  input.type = showing ? "text" : "password";
  toggle.textContent = showing ? "Hide" : "Show";
  toggle.setAttribute("aria-pressed", String(showing));
}

for (const toggle of document.querySelectorAll("[data-toggle-input]")) {
  toggle.addEventListener("click", () => toggleSecretInput(toggle));
}

rowsContainer.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLButtonElement && target.matches("[data-toggle-input]")) {
    toggleSecretInput(target);
  }
});

function clearVerifiedGmailCache() {
  return chrome.runtime.sendMessage({ type: "ERP_CLEAR_GMAIL_AUTH_CACHE" });
}

async function refreshGmailStatus() {
  try {
    await getAuthToken(false);
    gmailStatus.textContent = await verifyGmailAccount();
  } catch {
    gmailStatus.textContent = "Gmail is not authorized or the configured mailbox does not match.";
  }
}

authorizeGmailButton.addEventListener("click", async () => {
  authorizeGmailButton.disabled = true;
  gmailStatus.textContent = "Waiting for Google authorization...";
  try {
    await getAuthToken(true);
    gmailStatus.textContent = await verifyGmailAccount();
    setFeedback("Gmail authorization is ready.", "success");
  } catch (error) {
    gmailStatus.textContent = "Gmail is not authorized.";
    setFeedback(error instanceof Error ? error.message : "Gmail authorization failed.", "error");
  } finally {
    authorizeGmailButton.disabled = false;
  }
});

disconnectGmailButton.addEventListener("click", () => {
  disconnectGmailButton.disabled = true;
  chrome.identity.clearAllCachedAuthTokens(() => {
    const error = chrome.runtime.lastError;
    if (error) {
      setFeedback("Could not clear cached Gmail authorization. Try again.", "error");
    } else {
      void clearVerifiedGmailCache().catch(() => {
        setFeedback("Gmail token was cleared, but the temporary account-check cache could not be reset. Reload the extension.", "error");
      });
      gmailStatus.textContent = "Gmail is not authorized.";
      setFeedback("Cached Gmail authorization cleared. Remove the app from your Google Account to revoke access fully.", "success");
    }
    disconnectGmailButton.disabled = false;
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const questionInputs = [...form.querySelectorAll('[name="securityQuestion"]')];
  const answerInputs = [...form.querySelectorAll('[name="securityAnswer"]')];
  const securityQuestions = questionInputs.map((input, index) => ({
    question: input.value.trim(),
    answer: answerInputs[index].value
  })).filter((item) => item.question && item.answer);

  for (let index = 0; index < questionInputs.length; index += 1) {
    if (Boolean(questionInputs[index].value.trim()) !== Boolean(answerInputs[index].value)) {
      setFeedback("Each security question must have its matching answer.", "error");
      return;
    }
  }

  const credentials = {
    userId: document.querySelector("#userId").value.trim(),
    password: document.querySelector("#password").value,
    emailAddress: document.querySelector("#emailAddress").value.trim().toLowerCase(),
    securityQuestions
  };

  if (!credentials.userId || !credentials.password || !credentials.emailAddress) {
    setFeedback("Enter your ERP user ID, password, and Gmail address.", "error");
    return;
  }
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const saveButton = document.querySelector("#saveSettings");
  saveButton.disabled = true;
  try {
    await chrome.storage.local.set({ erpCredentials: credentials });
    setFeedback("Settings saved on this device.", "success");
    await refreshGmailStatus();
  } catch {
    setFeedback("Settings could not be saved. Check Chrome extension storage and try again.", "error");
  } finally {
    saveButton.disabled = false;
  }
});

document.querySelector("#clearSettings").addEventListener("click", async () => {
  try {
    await chrome.storage.local.remove("erpCredentials");
    form.reset();
    rowsContainer.replaceChildren();
    for (let index = 0; index < 3; index += 1) {
      rowsContainer.append(createQuestionRow(index));
    }
    gmailStatus.textContent = "Enter and save the Gmail mailbox to check authorization.";
    setFeedback("Saved ERP credentials and security answers were cleared.", "success");
  } catch {
    setFeedback("Could not clear saved settings. Try again.", "error");
  }
});

loadSettings().catch(() => {
  setFeedback("Could not load settings.", "error");
});

refreshGmailStatus();
