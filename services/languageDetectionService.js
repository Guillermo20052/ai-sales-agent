/**
 * Shared language detection from crawled page content.
 * Used by both trainingQueueService and websiteContextService during indexing.
 */

function detectLanguageFromPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return "en";
  const allContent = pages
    .map((p) => (p.cleaned_content || "").substring(0, 500))
    .join(" ");
  const sample = allContent.substring(0, 3000).toLowerCase();
  if (!sample) return "en";

  if (/[\u4e00-\u9fff]/.test(sample)) return "zh";
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(sample)) return "ja";
  if (/[\uac00-\ud7af]/.test(sample)) return "ko";
  if (/[\u0600-\u06ff]/.test(sample)) return "ar";
  if (/[\u0900-\u097f]/.test(sample)) return "hi";
  if (/[\u0400-\u04ff]/.test(sample)) return "ru";
  if (/[ãõçê]/.test(sample)) return "pt";
  if (/[áéíóúñ¿¡]/.test(sample)) return "es";
  if (/[äöüß]/.test(sample)) return "de";

  const frTokens = [" le ", " la ", " les ", " des ", " nous ", " vous ", " est ", " sont ", " avec "];
  if (frTokens.filter((t) => sample.includes(t)).length >= 3) return "fr";
  const itTokens = [" il ", " gli ", " della ", " sono ", " questo ", " anche "];
  if (itTokens.filter((t) => sample.includes(t)).length >= 3) return "it";
  const esTokens = [" de ", " que ", " para ", " con ", " servicio ", " servicios "];
  if (esTokens.filter((t) => sample.includes(t)).length >= 3) return "es";
  const ptTokens = [" você ", " nosso ", " serviço ", " produto ", " também "];
  if (ptTokens.filter((t) => sample.includes(t)).length >= 3) return "pt";

  return "en";
}

module.exports = {
  detectLanguageFromPages,
};
