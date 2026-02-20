const emailEl = document.getElementById("email");
const passwordEl = document.getElementById("password");
const statusEl = document.getElementById("status");
const saveButton = document.getElementById("saveButton");

saveButton.addEventListener("click", save);

init();

async function init() {
  const settings = await chrome.storage.local.get(["overcastEmail", "overcastPassword"]);
  emailEl.value = settings.overcastEmail || "";
  passwordEl.value = settings.overcastPassword || "";
}

async function save() {
  const email = emailEl.value.trim();
  const password = passwordEl.value;

  await chrome.storage.local.set({
    overcastEmail: email,
    overcastPassword: password
  });

  statusEl.textContent = "Saved.";
}
