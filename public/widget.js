(function () {
  const script = document.currentScript;
  const businessId = script.getAttribute("data-business");

  if (!businessId) {
    console.error("AI Agent: Missing data-business attribute.");
    return;
  }

  /* ==============================
     CREATE CHAT CONTAINER
  ============================== */

  const chatContainer = document.createElement("div");
  chatContainer.style.position = "fixed";
  chatContainer.style.bottom = "80px";
  chatContainer.style.right = "20px";
  chatContainer.style.width = "320px";
  chatContainer.style.height = "420px";
  chatContainer.style.background = "#ffffff";
  chatContainer.style.borderRadius = "12px";
  chatContainer.style.boxShadow = "0 10px 30px rgba(0,0,0,0.2)";
  chatContainer.style.display = "none";
  chatContainer.style.flexDirection = "column";
  chatContainer.style.overflow = "hidden";
  chatContainer.style.fontFamily = "Arial, sans-serif";
  chatContainer.style.zIndex = "9999";

  /* ==============================
     MESSAGES AREA
  ============================== */

  const messages = document.createElement("div");
  messages.style.flex = "1";
  messages.style.padding = "12px";
  messages.style.overflowY = "auto";
  messages.style.background = "#f8f9fa";

  /* ==============================
     INPUT AREA
  ============================== */

  const inputContainer = document.createElement("div");
  inputContainer.style.display = "flex";
  inputContainer.style.borderTop = "1px solid #ddd";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type your message...";
  input.style.flex = "1";
  input.style.padding = "12px";
  input.style.border = "none";
  input.style.outline = "none";

  const button = document.createElement("button");
  button.innerText = "Send";
  button.style.padding = "12px 16px";
  button.style.border = "none";
  button.style.background = "#007bff";
  button.style.color = "#fff";
  button.style.cursor = "pointer";

  inputContainer.appendChild(input);
  inputContainer.appendChild(button);

  chatContainer.appendChild(messages);
  chatContainer.appendChild(inputContainer);

  document.body.appendChild(chatContainer);

  /* ==============================
     FLOATING TOGGLE BUTTON
  ============================== */

  const toggleButton = document.createElement("button");
  toggleButton.innerText = "Chat";
  toggleButton.style.position = "fixed";
  toggleButton.style.bottom = "20px";
  toggleButton.style.right = "20px";
  toggleButton.style.padding = "12px 18px";
  toggleButton.style.borderRadius = "50px";
  toggleButton.style.border = "none";
  toggleButton.style.background = "#007bff";
  toggleButton.style.color = "#fff";
  toggleButton.style.cursor = "pointer";
  toggleButton.style.zIndex = "9999";

  document.body.appendChild(toggleButton);

  toggleButton.onclick = function () {
    chatContainer.style.display =
      chatContainer.style.display === "none" ? "flex" : "none";
  };

  /* ==============================
     MESSAGE HANDLING
  ============================== */

  function addMessage(text, sender) {
    const msg = document.createElement("div");
    msg.style.marginBottom = "8px";
    msg.style.padding = "8px 10px";
    msg.style.borderRadius = "8px";
    msg.style.maxWidth = "80%";

    if (sender === "user") {
      msg.style.background = "#007bff";
      msg.style.color = "#fff";
      msg.style.alignSelf = "flex-end";
      msg.style.marginLeft = "auto";
    } else {
      msg.style.background = "#e9ecef";
      msg.style.color = "#000";
      msg.style.alignSelf = "flex-start";
    }

    msg.innerText = text;
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    addMessage(text, "user");
    input.value = "";

    try {
      const res = await fetch(`/agent/${businessId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();

      if (data.reply) {
        addMessage(data.reply, "agent");
      } else if (data.error) {
        addMessage(data.error, "agent");
      } else {
        addMessage("Unexpected response.", "agent");
      }
    } catch (err) {
      addMessage("Error connecting to AI agent.", "agent");
    }
  }

  button.onclick = sendMessage;

  input.addEventListener("keypress", function (e) {
    if (e.key === "Enter") {
      sendMessage();
    }
  });
})();
