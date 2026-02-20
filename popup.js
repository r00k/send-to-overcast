const statusEl = document.getElementById("status");
const sendButton = document.getElementById("sendButton");
const optionsLink = document.getElementById("optionsLink");

optionsLink.addEventListener("click", async (event) => {
  event.preventDefault();
  await chrome.runtime.openOptionsPage();
});

sendButton.addEventListener("click", async () => {
  setBusy(true, "Analyzing this page and matching the episode in Overcast...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "send-current-tab-to-overcast"
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown failure");
    }

    statusEl.textContent = `Saved to Overcast. Match source: ${response.source}. Episode ID: ${response.itemID}.`;
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setBusy(false);
  }
});

init();

async function init() {
  const settings = await chrome.storage.local.get(["overcastEmail", "overcastPassword"]);
  const hasCreds = Boolean(settings.overcastEmail && settings.overcastPassword);
  if (!hasCreds) {
    statusEl.textContent = "Add your Overcast email/password in Options before first use.";
  }
}

function setBusy(isBusy, message = "") {
  sendButton.disabled = isBusy;
  sendButton.textContent = isBusy ? "Working..." : "Save Episode";
  if (message) {
    statusEl.textContent = message;
  }
}
