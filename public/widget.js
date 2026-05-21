(function () {
  const script = document.currentScript;
  const businessId = script.getAttribute("data-business");

  if (!businessId) {
    console.error("AI Agent: Missing data-business attribute.");
    return;
  }

  var config = window.AI_AGENT_CONFIG || {};
  var scriptSrc = script.getAttribute("src") || "";
  var inferredBase = "";
  try {
    inferredBase = new URL(scriptSrc, window.location.href).origin;
  } catch (_) {
    inferredBase = "";
  }
  var apiBase = (config.apiBase || inferredBase || "").replace(/\/$/, "");

  var domPurifyReady =
    typeof DOMPurify !== "undefined"
      ? Promise.resolve()
      : new Promise(function (resolve) {
          var s = document.createElement("script");
          s.src = apiBase + "/purify.min.js";
          s.onload = resolve;
          s.onerror = resolve;
          document.head.appendChild(s);
        });

  var widgetLang =
    (navigator.language || navigator.userLanguage || "en").toLowerCase();
  widgetLang = widgetLang.indexOf("es") === 0 ? "es" : "en";
  var i18n =
    widgetLang === "es"
      ? {
          chat: "Chat",
          typeMessage: "Escribe tu mensaje...",
          send: "Enviar",
          fallbackWelcome: "Hola, ¿en qué puedo ayudarte hoy?",
          genericError: "Algo salió mal. Intenta de nuevo.",
          networkError: "No se pudo conectar con el agente. Intenta de nuevo.",
        }
      : {
          chat: "Chat",
          typeMessage: "Type your message...",
          send: "Send",
          fallbackWelcome: "Hi, how can I help you today?",
          genericError: "Something went wrong. Please try again.",
          networkError: "Could not reach the agent. Please try again.",
        };
  var accent = config.accentColor || "#6366f1";
  var businessName = config.businessName || "Chat";
  var conversationStorageKey = "ai_agent_conv_" + String(businessId);
  var visitorStorageKey = "ai_agent_visitor_" + String(businessId);
  var conversationId = null;
  var visitorId = null;
  var conversationTsKey = "ai_agent_conv_ts_" + String(businessId);
  var CONV_TTL_MS = 30 * 60 * 1000;

  try {
    var savedId = localStorage.getItem(conversationStorageKey);
    var savedTs = parseInt(localStorage.getItem(conversationTsKey) || "0", 10);
    var isExpired = !savedTs || (Date.now() - savedTs) > CONV_TTL_MS;
    if (savedId && !isExpired) {
      conversationId = savedId;
    } else {
      conversationId = null;
      localStorage.removeItem(conversationStorageKey);
      localStorage.removeItem(conversationTsKey);
    }
  } catch (_) {}
  try {
    visitorId = localStorage.getItem(visitorStorageKey) || null;
    if (!visitorId) {
      visitorId = "v_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(visitorStorageKey, visitorId);
    }
  } catch (_) {}

  /* Dark theme tokens (match main app) */
  var bg = "#0a0a0b";
  var surface = "#161618";
  var surfaceHover = "#1c1c1f";
  var border = "rgba(255,255,255,0.08)";
  var borderStrong = "rgba(255,255,255,0.12)";
  var text = "#fafafa";
  var textMuted = "#a1a1aa";

  /* ==============================
     STYLES + KEYFRAMES
  ============================== */

  var style = document.createElement("style");
  style.textContent =
    "@keyframes widget-typing-bounce { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }" +
    " .widget-agent-msg a { color: #93c5fd; text-decoration: underline; } ";
  document.head.appendChild(style);

  /* ==============================
     CHAT CONTAINER
  ============================== */

  const chatContainer = document.createElement("div");
  chatContainer.style.cssText =
    "position:fixed;bottom:88px;right:20px;width:380px;height:500px;background:" + surface + ";border:1px solid " + border + ";border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.4);display:none;flex-direction:column;overflow:hidden;font-family:'Inter',-apple-system,sans-serif;z-index:9999;";

  var header = document.createElement("div");
  header.style.cssText =
    "padding:14px 16px;font-weight:600;font-size:15px;color:" + text + ";flex-shrink:0;background:" + bg + ";border-bottom:1px solid " + border + ";";
  header.textContent = businessName;

  const messages = document.createElement("div");
  messages.style.cssText =
    "flex:1;padding:16px;overflow-y:auto;background:#18181b;display:flex;flex-direction:column;min-height:0;";

  var inputWrap = document.createElement("div");
  inputWrap.style.cssText =
    "display:flex;border-top:1px solid " + border + ";background:" + surface + ";padding:10px 12px;gap:8px;align-items:center;flex-shrink:0;";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = i18n.typeMessage;
  input.style.cssText =
    "flex:1;padding:12px 14px;border:1px solid " + border + ";border-radius:10px;outline:none;font-size:14px;font-family:inherit;background:#18181b;color:" + text + ";";
  input.addEventListener("focus", function () {
    input.style.borderColor = borderStrong;
    input.style.boxShadow = "0 0 0 3px rgba(255,255,255,0.06)";
  });
  input.addEventListener("blur", function () {
    input.style.borderColor = border;
    input.style.boxShadow = "none";
  });

  const button = document.createElement("button");
  button.innerText = i18n.send;
  button.style.cssText =
    "padding:12px 18px;border:none;border-radius:10px;background:#fff;color:#0a0a0b;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;transition:opacity 0.2s ease, transform 0.2s ease;";
  button.addEventListener("mouseenter", function () {
    button.style.opacity = "0.92";
    button.style.transform = "translateY(-1px)";
  });
  button.addEventListener("mouseleave", function () {
    button.style.opacity = "1";
    button.style.transform = "translateY(0)";
  });

  inputWrap.appendChild(input);
  inputWrap.appendChild(button);

  chatContainer.appendChild(header);
  chatContainer.appendChild(messages);
  chatContainer.appendChild(inputWrap);

  document.body.appendChild(chatContainer);

  /* ==============================
     FLOATING TOGGLE BUTTON
  ============================== */

  const toggleButton = document.createElement("button");
  toggleButton.innerHTML = i18n.chat;
  toggleButton.style.cssText =
    "position:fixed;bottom:20px;right:20px;padding:14px 22px;border-radius:50px;border:none;background:#fff;color:#0a0a0b;font-weight:600;font-size:14px;cursor:pointer;z-index:9999;font-family:inherit;box-shadow:0 4px 20px rgba(0,0,0,0.35);transition:opacity 0.2s ease, transform 0.2s ease;";
  toggleButton.addEventListener("mouseenter", function () {
    toggleButton.style.opacity = "0.92";
    toggleButton.style.transform = "translateY(-2px)";
  });
  toggleButton.addEventListener("mouseleave", function () {
    toggleButton.style.opacity = "1";
    toggleButton.style.transform = "translateY(0)";
  });

  document.body.appendChild(toggleButton);

  let welcomeShown = false;

  toggleButton.onclick = function () {
    const opening = chatContainer.style.display === "none";
    chatContainer.style.display =
      chatContainer.style.display === "none" ? "flex" : "none";

    if (opening && !welcomeShown) {
      welcomeShown = true;
      fetch(apiBase + "/agent/" + businessId + "/welcome?lang=" + encodeURIComponent(widgetLang))
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (data.businessName && !config.businessName) {
            header.textContent = data.businessName;
          }
          addMessage(data.welcomeMessage || i18n.fallbackWelcome, "agent");
        })
        .catch(function () {
          addMessage(i18n.fallbackWelcome, "agent");
        });
    }
  };

  /* ==============================
     MESSAGE HANDLING
  ============================== */

  async function addMessage(text, sender) {
    const msg = document.createElement("div");
    msg.style.marginBottom = "10px";
    msg.style.padding = "12px 14px";
    msg.style.borderRadius = "14px";
    msg.style.maxWidth = "85%";
    msg.style.fontSize = "14px";
    msg.style.lineHeight = "1.45";

    if (sender === "user") {
      msg.style.background = "#fff";
      msg.style.color = "#0a0a0b";
      msg.style.alignSelf = "flex-end";
      msg.style.marginLeft = "auto";
      msg.style.borderBottomRightRadius = "4px";
      msg.innerText = text;
    } else {
      msg.className = "widget-agent-msg";
      msg.style.background = surfaceHover;
      msg.style.color = text;
      msg.style.alignSelf = "flex-start";
      msg.style.borderBottomLeftRadius = "4px";
      msg.style.border = "1px solid " + border;
      await domPurifyReady;
      var clean =
        typeof DOMPurify !== "undefined"
          ? DOMPurify.sanitize(String(text || ""), {
              ALLOWED_TAGS: ["a", "b", "strong", "i", "em", "ul", "ol", "li", "p", "br"],
              ALLOWED_ATTR: ["href", "target"],
            })
          : String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      msg.innerHTML = clean;
    }

    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  function addTypingIndicator() {
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "10px";
    wrap.style.alignSelf = "flex-start";
    wrap.setAttribute("data-typing", "1");

    const bubble = document.createElement("div");
    bubble.style.cssText =
      "background:" + surfaceHover + ";padding:12px 16px;border-radius:14px;border-bottom-left-radius:4px;display:inline-flex;gap:5px;align-items:center;border:1px solid " + border + ";";

    for (var i = 0; i < 3; i++) {
      const dot = document.createElement("span");
      dot.style.cssText =
        "width:7px;height:7px;border-radius:50%;background:#a1a1aa;animation:widget-typing-bounce 0.6s ease-in-out " +
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
    const el = messages.querySelector("[data-typing='1']");
    if (el) el.remove();
  }

  function getTypingDelay(responseLength) {
    if (responseLength < 100) return 600;
    if (responseLength <= 300) return 900;
    if (responseLength <= 600) return 1200;
    return 1500;
  }

  var isSending = false;

  async function sendMessage() {
    if (isSending) return;
    const userText = input.value.trim();
    if (!userText) return;
    isSending = true;
    input.disabled = true;
    button.disabled = true;

    addMessage(userText, "user");
    input.value = "";

    addTypingIndicator();
    var typingStart = Date.now();

    try {
      var endpoint = apiBase + "/agent/" + businessId;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: userText,
          conversationId: conversationId,
          visitorId: visitorId,
        }),
      });

      const data = await res.json().catch(function () {
        return {};
      });

      var replyText = data.reply || data.error || "";
      var typingMinMs = getTypingDelay(replyText.length);
      var elapsed = Date.now() - typingStart;
      var wait = Math.max(0, typingMinMs - elapsed);
      await new Promise(function (r) {
        setTimeout(r, wait);
      });

      removeTypingIndicator();

      if (data.reply) {
        addMessage(data.reply, "agent");
        if (data.conversationId) {
          conversationId = data.conversationId;
          try {
            localStorage.setItem(conversationStorageKey, String(conversationId));
            localStorage.setItem(conversationTsKey, String(Date.now()));
          } catch (_) {}
        }
      } else if (data.error) {
        addMessage(data.error, "agent");
      } else {
        addMessage(i18n.genericError, "agent");
      }
    } catch (err) {
      var elapsed = Date.now() - typingStart;
      var wait = Math.max(0, 600 - elapsed);
      await new Promise(function (r) {
        setTimeout(r, wait);
      });
      removeTypingIndicator();
      addMessage(i18n.networkError, "agent");
    } finally {
      isSending = false;
      input.disabled = false;
      button.disabled = false;
      input.focus();
    }
  }

  button.onclick = sendMessage;

  input.addEventListener("keypress", function (e) {
    if (e.key === "Enter") {
      sendMessage();
    }
  });
})();
