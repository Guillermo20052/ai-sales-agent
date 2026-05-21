const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_REGEX = /(?:\+?\d[\d\s\-()]{7,}\d)/;

const NAME_REGEX = /(?:(?:my name is|i'm|i am|me llamo|soy)\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i;

function extractLeadFields(text) {
  const raw = String(text || "");
  const emailMatch = raw.match(EMAIL_REGEX);
  const phoneMatch = raw.match(PHONE_REGEX);
  const nameMatch = raw.match(NAME_REGEX);
  return {
    email: emailMatch ? emailMatch[0].trim() : null,
    phone: phoneMatch ? phoneMatch[0].trim() : null,
    name: nameMatch ? nameMatch[1].trim() : null,
  };
}

function detectLeadScore(message, history) {
  const m = String(message || "").toLowerCase();
  const h = Array.isArray(history) ? history : [];

  let score = 0;
  const strongCues = [
    "book",
    "demo",
    "quote",
    "pricing",
    "contact me",
    "call me",
    "speak to sales",
    "presupuesto",
    "precio",
    "cotizacion",
    "cotización",
    "demo",
    "contactame",
    "contáctame",
    "llamame",
    "llámame",
  ];
  const mediumCues = [
    "interested",
    "plan",
    "package",
    "buy",
    "trial",
    "me interesa",
    "interesado",
    "paquete",
    "comprar",
    "prueba",
  ];

  if (strongCues.some((c) => m.includes(c))) score += 3;
  if (mediumCues.some((c) => m.includes(c))) score += 1;

  const userTurns = h.filter((item) => item && item.role === "user").length;
  if (userTurns >= 3) score += 1;

  const extracted = extractLeadFields(message);
  if (extracted.email) score += 3;
  if (extracted.phone) score += 2;

  return score;
}

function shouldPromptLeadCapture(message, history) {
  if (detectLeadScore(message, history) < 4) return false;
  const h = Array.isArray(history) ? history : [];
  const userTurns = h.filter((m) => m && m.role === "user").length;
  if (userTurns < 2) return false;
  return true;
}

const CONTACT_REQUEST_PATTERNS = /\b(email|e-mail|correo|mail|contact\s?info|phone|número|numéro|telefon|teléfono|reach\s?you|follow\s?up|send\s?you|get\s?back\s?to\s?you|share\s?your\s?(email|contact))\b/i;

function responseAlreadyAsksForContact(aiReply) {
  return CONTACT_REQUEST_PATTERNS.test(String(aiReply || ""));
}

const LEAD_PROMPT_TEMPLATES = {
  en: { hasEmail: "Great, I have your email. I'll share the information with the team so they can follow up with more details.", noEmail: "If you'd like, I can connect you with the team. Would you like to share your email so we can send more information?" },
  es: { hasEmail: "Perfecto, ya tengo tu correo. Le compartiré la información al equipo para que te contacten con más detalles.", noEmail: "Si quieres, puedo conectarte con el equipo. ¿Te gustaría compartir tu correo para enviarte más información?" },
  fr: { hasEmail: "Parfait, j'ai votre e-mail. Je transmettrai les informations à l'équipe pour qu'elle puisse vous recontacter.", noEmail: "Si vous le souhaitez, je peux vous mettre en contact avec l'équipe. Souhaitez-vous partager votre e-mail pour recevoir plus d'informations ?" },
  de: { hasEmail: "Perfekt, ich habe Ihre E-Mail. Ich leite die Informationen an das Team weiter, damit es sich mit Ihnen in Verbindung setzt.", noEmail: "Wenn Sie möchten, kann ich Sie mit dem Team verbinden. Möchten Sie Ihre E-Mail hinterlassen, damit wir Ihnen weitere Informationen zusenden können?" },
  pt: { hasEmail: "Perfeito, já tenho seu e-mail. Vou compartilhar as informações com a equipe para que entrem em contato com mais detalhes.", noEmail: "Se preferir, posso conectá-lo com a equipe. Gostaria de compartilhar seu e-mail para que possamos enviar mais informações?" },
  it: { hasEmail: "Perfetto, ho la tua email. Condividerò le informazioni con il team per un seguito con maggiori dettagli.", noEmail: "Se vuoi, posso metterti in contatto con il team. Vorresti condividere la tua email per ricevere maggiori informazioni?" },
  zh: { hasEmail: "好的，我已收到您的邮箱。我会将信息转给团队，他们会尽快与您联系。", noEmail: "如果您愿意，我可以帮您联系团队。您是否愿意留下邮箱，以便我们发送更多信息？" },
  ja: { hasEmail: "ありがとうございます。メールアドレスを承りました。チームに情報を共有し、詳細をご連絡いたします。", noEmail: "よろしければチームにおつなぎいたします。メールアドレスを教えていただければ、詳細情報をお送りいたします。" },
  ko: { hasEmail: "감사합니다. 이메일을 확인했습니다. 팀에 정보를 전달하여 자세한 내용을 안내드리겠습니다.", noEmail: "원하시면 팀과 연결해 드릴 수 있습니다. 이메일을 알려주시면 추가 정보를 보내드릴까요?" },
  ar: { hasEmail: "ممتاز، لدي بريدك الإلكتروني. سأشارك المعلومات مع الفريق ليتواصلوا معك بمزيد من التفاصيل.", noEmail: "إذا أردت، يمكنني توصيلك بالفريق. هل تود مشاركة بريدك الإلكتروني لنرسل لك مزيداً من المعلومات؟" },
  ru: { hasEmail: "Отлично, я получил ваш email. Передам информацию команде, и они свяжутся с вами для уточнения деталей.", noEmail: "Если хотите, я могу связать вас с командой. Хотите оставить email, чтобы мы отправили дополнительную информацию?" },
};

function getLeadPrompt(language, hasEmail) {
  const tmpl = LEAD_PROMPT_TEMPLATES[language] || LEAD_PROMPT_TEMPLATES.en;
  return hasEmail ? tmpl.hasEmail : tmpl.noEmail;
}

module.exports = {
  extractLeadFields,
  detectLeadScore,
  shouldPromptLeadCapture,
  responseAlreadyAsksForContact,
  getLeadPrompt,
};
