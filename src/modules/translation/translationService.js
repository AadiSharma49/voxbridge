export async function translateText(text, sourceLang = 'en', targetLang = 'hi') {
  try {
    console.log('Translation input:', text, { sourceLang, targetLang });

    const res = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`
    );

    const data = await res.json();

    // Extract translated text
    const translated = data[0].map(item => item[0]).join("");

    console.log("Translated:", translated);

    return translated;
  } catch (err) {
    console.error("Translation error:", err);
    return text;
  }
}
