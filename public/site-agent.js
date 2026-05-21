(function () {
  var base = (typeof window !== "undefined" && window.location && window.location.origin) || "";
  var domPurifyReady =
    typeof DOMPurify !== "undefined"
      ? Promise.resolve()
      : new Promise(function (resolve) {
          var s = document.createElement("script");
          s.src = base + "/purify.min.js";
          s.onload = resolve;
          s.onerror = resolve;
          document.head.appendChild(s);
        });

  /* Dark theme to match landing (--bg-elevated, --text, --border) */
  var bgElevated = "#18181b";
  var bgSubtle = "#111113";
  var text = "#fafafa";
  var textMuted = "#a1a1aa";
  var border = "rgba(255,255,255,0.08)";
  var accent = "#ffffff";
  var accentHover = "#e4e4e7";
  var TYPING_MIN_MS = 1400;
  var MAX_HISTORY = 10;
  var chatHistory = [];

  var style = document.createElement("style");
  style.textContent =
    "@keyframes site-agent-typing-bounce { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }" +
    " .site-agent-input::placeholder { color: #71717a; } ";
  document.head.appendChild(style);

  var chatContainer = document.createElement("div");
  chatContainer.style.cssText =
    "position:fixed;bottom:88px;right:20px;width:380px;height:500px;background:" +
    bgElevated +
    ";border:1px solid " +
    border +
    ";border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.4);display:none;flex-direction:column;overflow:hidden;font-family:'Inter',-apple-system,sans-serif;z-index:9999;";

  var header = document.createElement("div");
  header.style.cssText =
    "padding:14px 16px;font-weight:600;font-size:15px;color:" +
    text +
    ";flex-shrink:0;background:" +
    bgSubtle +
    ";border-bottom:1px solid " +
    border +
    ";";
  header.textContent = "YIGO";

  var messages = document.createElement("div");
  messages.style.cssText =
    "flex:1;padding:16px;overflow-y:auto;background:" +
    bgElevated +
    ";display:flex;flex-direction:column;min-height:0;";

  var inputWrap = document.createElement("div");
  inputWrap.style.cssText =
    "display:flex;border-top:1px solid " +
    border +
    ";background:" +
    bgSubtle +
    ";padding:10px 12px;gap:8px;align-items:center;flex-shrink:0;";

  var input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Ask about the product...";
  input.className = "site-agent-input";
  input.style.cssText =
    "flex:1;padding:12px 14px;border:1px solid " +
    border +
    ";border-radius:10px;outline:none;font-size:14px;font-family:inherit;background:" +
    bgElevated +
    ";color:" +
    text +
    ";";
  input.addEventListener("focus", function () {
    input.style.borderColor = "rgba(255,255,255,0.2)";
    input.style.boxShadow = "0 0 0 2px rgba(255,255,255,0.1)";
  });
  input.addEventListener("blur", function () {
    input.style.borderColor = border;
    input.style.boxShadow = "none";
  });

  var button = document.createElement("button");
  button.innerText = "Send";
  button.style.cssText =
    "padding:12px 18px;border:none;border-radius:10px;background:" +
    accent +
    ";color:#0a0a0b;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;";
  button.addEventListener("mouseenter", function () {
    button.style.background = accentHover;
  });
  button.addEventListener("mouseleave", function () {
    button.style.background = accent;
  });

  inputWrap.appendChild(input);
  inputWrap.appendChild(button);
  chatContainer.appendChild(header);
  chatContainer.appendChild(messages);
  chatContainer.appendChild(inputWrap);
  document.body.appendChild(chatContainer);

  var toggleButton = document.createElement("button");
  toggleButton.innerHTML = "Help";
  toggleButton.style.cssText =
    "position:fixed;bottom:20px;right:20px;padding:14px 22px;border-radius:50px;border:none;background:" +
    accent +
    ";color:#0a0a0b;font-weight:600;font-size:14px;cursor:pointer;z-index:9999;font-family:inherit;box-shadow:0 4px 14px rgba(0,0,0,0.3);";
  toggleButton.addEventListener("mouseenter", function () {
    toggleButton.style.background = accentHover;
  });
  toggleButton.addEventListener("mouseleave", function () {
    toggleButton.style.background = accent;
  });
  document.body.appendChild(toggleButton);

  var welcomeShown = false;
  var YIGO_FIRST_MESSAGE = "Hi, I'm YIGO. How can I help you today?";
  toggleButton.onclick = function () {
    var opening = chatContainer.style.display === "none";
    chatContainer.style.display =
      chatContainer.style.display === "none" ? "flex" : "none";
    if (opening && !welcomeShown) {
      welcomeShown = true;
      addTypingIndicator();
      setTimeout(function () {
        removeTypingIndicator();
        addMessage(YIGO_FIRST_MESSAGE, "agent");
      }, 800);
    }
  };

  async function addMessage(text, sender) {
    var msg = document.createElement("div");
    msg.style.marginBottom = "10px";
    msg.style.padding = "12px 14px";
    msg.style.borderRadius = "14px";
    msg.style.maxWidth = "85%";
    msg.style.fontSize = "14px";
    msg.style.lineHeight = "1.45";
    if (sender === "user") {
      msg.style.background = accent;
      msg.style.color = "#0a0a0b";
      msg.style.alignSelf = "flex-end";
      msg.style.marginLeft = "auto";
      msg.style.borderBottomRightRadius = "4px";
      msg.innerText = text;
    } else {
      msg.style.background = bgSubtle;
      msg.style.color = text;
      msg.style.border = "1px solid " + border;
      msg.style.alignSelf = "flex-start";
      msg.style.borderBottomLeftRadius = "4px";
      await domPurifyReady;
      var raw = String(text || "");
      var withLinks =
        /<a\s+href/i.test(raw)
          ? raw
          : raw.replace(
              /(https?:\/\/[^\s<>"')\]]+)/g,
              '<a href="$1" target="_blank" rel="noopener">$1</a>'
            );
      var clean =
        typeof DOMPurify !== "undefined"
          ? DOMPurify.sanitize(withLinks, {
              ALLOWED_TAGS: ["a", "b", "strong", "i", "em", "ul", "ol", "li", "p", "br"],
              ALLOWED_ATTR: ["href", "target", "rel"],
            })
          : raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      msg.innerHTML = clean;
    }
    if (sender === "agent") {
      msg.querySelectorAll("a").forEach(function (a) {
        a.style.color = "#93c5fd";
        a.style.textDecoration = "underline";
      });
    }
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  function addTypingIndicator() {
    var wrap = document.createElement("div");
    wrap.style.marginBottom = "10px";
    wrap.style.alignSelf = "flex-start";
    wrap.setAttribute("data-typing", "1");
    var bubble = document.createElement("div");
    bubble.style.cssText =
      "background:" +
      bgSubtle +
      ";padding:12px 16px;border-radius:14px;border-bottom-left-radius:4px;display:inline-flex;gap:5px;align-items:center;border:1px solid " +
      border +
      ";";
    for (var i = 0; i < 3; i++) {
      var dot = document.createElement("span");
      dot.style.cssText =
        "width:7px;height:7px;border-radius:50%;background:" +
        textMuted +
        ";animation:site-agent-typing-bounce 0.6s ease-in-out " +
        i * 0.15 +
        "s infinite both;";
      bubble.appendChild(dot);
    }
    wrap.appendChild(bubble);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
    return wrap;
  }

  function removeTypingIndicator() {
    var el = messages.querySelector("[data-typing='1']");
    if (el) el.remove();
  }

  async function sendMessage() {
    var text = input.value.trim();
    if (!text) return;

    addMessage(text, "user");
    chatHistory.push({ role: "user", content: text });
    if (chatHistory.length > MAX_HISTORY * 2) {
      chatHistory = chatHistory.slice(-MAX_HISTORY * 2);
    }
    input.value = "";

    addTypingIndicator();
    var typingStart = Date.now();

    try {
      var history = chatHistory.slice(-MAX_HISTORY * 2).map(function (m) {
        return { role: m.role, content: m.content };
      });
      var res = await fetch("/agent/site-help", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: history }),
      });
      var data = await res.json().catch(function () {
        return {};
      });

      var elapsed = Date.now() - typingStart;
      var wait = Math.max(0, TYPING_MIN_MS - elapsed);
      await new Promise(function (r) {
        setTimeout(r, wait);
      });
      removeTypingIndicator();

      if (data.reply) {
        addMessage(data.reply, "agent");
        chatHistory.push({ role: "assistant", content: data.reply });
      } else if (data.error) {
        addMessage(data.error, "agent");
      } else {
        addMessage("Something went wrong. Please try again.", "agent");
      }
    } catch (err) {
      var elapsed = Date.now() - typingStart;
      var wait = Math.max(0, TYPING_MIN_MS - elapsed);
      await new Promise(function (r) {
        setTimeout(r, wait);
      });
      removeTypingIndicator();
      addMessage("Could not reach the assistant. Please try again.", "agent");
    }
  }

  button.onclick = sendMessage;
  input.addEventListener("keypress", function (e) {
    if (e.key === "Enter") sendMessage();
  });
})();
