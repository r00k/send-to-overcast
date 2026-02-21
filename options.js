const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const anthropicApiKeyEl = document.getElementById("anthropicApiKey");
const statusEl = document.getElementById("status");
const saveButton = document.getElementById("saveButton");

saveButton.addEventListener("click", save);

init();

async function init() {
  const settings = await chrome.storage.local.get(["overcastEmail", "overcastPassword", "anthropicApiKey"]);
  emailEl.value = settings.overcastEmail || "";
  passwordEl.value = settings.overcastPassword || "";
  anthropicApiKeyEl.value = settings.anthropicApiKey || "";
}

async function save() {
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  const anthropicApiKey = anthropicApiKeyEl.value.trim();

  await chrome.storage.local.set({
    overcastEmail: email,
    overcastPassword: password,
    anthropicApiKey
  });

  statusEl.textContent = "Saved.";
}
