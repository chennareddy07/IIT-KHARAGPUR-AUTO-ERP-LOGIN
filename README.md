# ERP Login Assistant

A lightweight Manifest V3 Chrome extension for IIT Kharagpur ERP. It can fill the ERP login form, match the currently displayed security question against locally configured answers, retrieve a recently sent sign-in OTP from the user's authorized Gmail account, and submit it.

## Features

- **Fill ERP Login:** fills the user ID, password, and answer matching the current ERP security question. It does not guess answers.
- **Fetch OTP and sign in:** after the user requests an OTP through ERP, searches Gmail for a recent matching message, fills the OTP, and submits the form.
- **Auto Login:** validates the ERP tab, fills the form, clicks the ERP Send OTP button, waits for ERP's native OTP-sent confirmation, retrieves the OTP, and submits it.
- **Local settings:** each user configures their own ERP ID, password, security Q&A pairs, and Gmail address.
- **Persistent side panel:** stays open while switching tabs and includes visible progress, diagnostics, and a close control.
- **GitHub credit:** [chennareddy07](https://github.com/chennareddy07).

## Privacy and security

- Each person uses their own ERP credentials and authorizes their own Gmail account. Never share passwords, answers, OTPs, or OAuth tokens with anyone.
- The extension does not use a project-controlled backend. ERP credentials are entered into the official ERP form; Gmail API requests are made directly to Google's Gmail API.
- Do not give anyone your Gmail password. Google authorization is handled by Chrome's identity API.
- ERP credentials and security answers are stored in `chrome.storage.local`. Chrome local extension storage is not encrypted by this extension; use a trusted device and browser profile.
- Gmail access tokens are managed by Chrome's identity API. The extension does not write them to its own storage or log them.
- Gmail access requires `gmail.readonly`, which can read mailbox messages. Gmail does not offer an OTP-only read scope; this extension searches only recent messages matching the ERP OTP phrase and does not display the email contents.
- Auto Login requires Chrome's powerful `debugger` permission to observe and acknowledge the ERP's native JavaScript alert. Chrome displays a warning. The extension attaches only to the validated ERP tab during this step, accepts only the OTP-sent confirmation or recognized answer-mismatch alert, and detaches afterward.
- CAPTCHA, anti-bot challenges, and other additional security verification are not bypassed.

## Install in Chrome

1. Download or clone the repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the project folder.
5. Review Chrome's permission warnings, especially the `debugger` warning. Do not proceed unless you trust this extension's code.
6. Click the extension toolbar icon to open its side panel.

### Gmail OAuth setup

The manifest contains a Google OAuth **client ID**, which is an application identifier, not a client secret. The Gmail API must be enabled for the associated Google Cloud project, and the OAuth consent screen must be configured. If the app remains in testing, add each tester's Google account to the consent screen's test users.

Chrome's OAuth client is associated with an extension ID. For a published extension, use its stable Chrome Web Store ID with the OAuth client. For local unpacked installations shared with friends, each install can have a different extension ID: configure a Chrome-extension OAuth client for that user's extension ID and update the `oauth2.client_id` in their local `manifest.json`, then reload the extension. Do not put OAuth client secrets in the extension; Chrome extension OAuth uses the client ID and the user's own consent. Google's consent-screen verification and testing restrictions may apply.

To connect an account:

1. In Settings, enter the Google mailbox that receives ERP OTPs and save.
2. Choose **Authorize Gmail** and approve the read-only access request for that mailbox.
3. The extension checks that the authorized Google account matches the configured mailbox.
4. Use **Disconnect** to clear Chrome's cached authorization. To revoke previously granted access fully, also remove the app in your Google Account security settings.

## Configure ERP account and security questions

Open **Settings** from the side panel. Enter your ERP user ID, ERP password, and the exact wording of your security questions with their answers. Up to three question/answer pairs are supported. Password and answers are masked initially and can be temporarily revealed with the Show controls. Select **Save settings**.

Security questions and answers must be accurate. The extension matches the displayed question after normalizing whitespace and capitalization; it never tries alternative answers.

## Sign in

### Auto Login

1. Open the ERP login page. The extension accepts HTTPS paths under `/IIT_ERP3/` and the observed ERP redirect `/SSOAdministration/login.htm` on `erp.iitkgp.ac.in`.
2. Open the side panel and select **Auto Login**.
3. Follow the status and progress list. On the normal flow, the extension fills the form, requests the OTP, waits for ERP's confirmation, searches Gmail for up to five minutes, submits the OTP, and checks the ERP result.
4. If ERP displays an unrecognized alert, the flow stops for manual review. If ERP rejects the security answer, check the matching entry in Settings.

The supplied ERP HTML uses `#getotp` to call `getEmilOTP.htm`; its AJAX success callback invokes native `alert(json.msg)`. This is a browser-controlled JavaScript alert, not a Bootstrap or DOM modal. The manual flow leaves the alert for the user. Auto Login uses the Chrome DevTools Protocol to accept only the recognized OTP confirmation or answer-mismatch alert.

### Manual flow

1. Select **Fill ERP Login** and review the fields and matched question.
2. Click ERP's **Send OTP** button and dismiss its alert.
3. Select **Fetch OTP and sign in** in the side panel.
4. Review the ERP page to confirm the result.

## Requested permissions

- `storage`: saves user-entered ERP configuration locally.
- `identity`: requests Gmail OAuth authorization and uses Chrome-managed access tokens.
- `tabs`: finds the active tab and sends messages to the ERP tab.
- `scripting`: checks/loads the content script only after validating the ERP URL, and checks the ERP's post-submit result in that validated tab.
- `sidePanel`: provides the persistent assistant panel.
- `debugger`: observes/handles ERP's native OTP alert during Auto Login. This is powerful and Chrome shows a permission warning.
- ERP host access: limited to `https://erp.iitkgp.ac.in/IIT_ERP3/*` and `https://erp.iitkgp.ac.in/SSOAdministration/*`.
- Gmail API host access: `https://gmail.googleapis.com/*`.
- OAuth scope: `https://www.googleapis.com/auth/gmail.readonly`.

No `<all_urls>`, cookies, history, or remote JavaScript permissions are requested. Extension pages use bundled scripts and styles; no third-party script CDN is used.

## Troubleshooting

- **ERP page not detected:** check the active tab is HTTPS and its URL is under `/IIT_ERP3/` or is `/SSOAdministration/login.htm` on the ERP host. Expand **Temporary tab diagnostics** in the side panel.
- **Security question was not recognized:** add the exact wording currently shown by ERP to Settings.
- **ERP says the answer mismatched:** the saved answer for the currently displayed question does not match ERP's stored answer. Correct it in Settings. Do not share the answer.
- **Please reconnect Gmail:** authorize Gmail again and confirm the configured mailbox matches the account Chrome authorized.
- **OTP was not received:** check ERP confirmed sending, verify the authorized mailbox, and ensure its message contains the phrase used by the OTP matcher. Polling uses five-second intervals and a five-minute limit.
- **Google OAuth error:** check Gmail API activation, consent-screen/test-user configuration, the OAuth client type, and its registered extension ID. A locally unpacked extension's ID may differ for each user. Google's testing or verification policy may block accounts/scopes until configured.
- **Login result is unclear:** the extension confirms success only on the known ERP success route or when a visible sign-out control appears without login/OTP fields. If neither is present, review the ERP page directly.
- **Additional verification:** complete it manually. The extension does not bypass it.

## Sharing checklist

- Share the source only after reviewing the permissions and OAuth setup.
- Every user enters their own ERP details and authorizes their own Gmail account.
- Never collect other users' credentials or OTPs.
- Do not share a Chrome profile containing saved credentials.
- Never add client secrets, private keys, `.env` files, credentials downloads, or token files to source control.

## Repository checks

This project has no package manager, build, lint, or test configuration. Validate JavaScript syntax with `node --check` on each `.js` file and parse `manifest.json` before loading it in Chrome. Real ERP login and Gmail authorization must be tested manually with an account you control.
