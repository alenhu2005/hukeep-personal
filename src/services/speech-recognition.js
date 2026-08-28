const ERROR_MESSAGES = {
  'not-allowed': '請允許麥克風權限後再試一次',
  'service-not-allowed': '瀏覽器不允許使用語音辨識服務',
  'audio-capture': '找不到可用的麥克風',
  'no-speech': '沒有聽到語音，請靠近麥克風再試一次',
  'network': '語音辨識服務目前無法連線',
  'language-not-supported': '這台裝置尚未安裝繁體中文語音模型',
};

async function enableLocalRecognition(Recognition, recognition, lang) {
  if (!('processLocally' in recognition) || typeof Recognition.available !== 'function') {
    return false;
  }
  try {
    const availability = await Recognition.available({ langs: [lang], processLocally: true });
    if (availability !== 'available') return false;
    recognition.processLocally = true;
    return true;
  } catch {
    return false;
  }
}

export async function recognizeSpeechOnce(options = {}) {
  const Recognition =
    options.Recognition ?? globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
  if (!Recognition) throw new Error('這個瀏覽器不支援口語辨識，仍可直接輸入口語句子');

  const recognition = new Recognition();
  recognition.lang = options.lang || 'zh-TW';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  const local = await enableLocalRecognition(Recognition, recognition, recognition.lang);

  return new Promise((resolve, reject) => {
    let settled = false;
    recognition.onresult = event => {
      const result = event.results?.[event.resultIndex ?? 0]?.[0];
      const transcript = String(result?.transcript ?? '').trim();
      if (!transcript) return;
      settled = true;
      resolve({
        transcript,
        confidence: Number.isFinite(result.confidence) ? result.confidence : 0,
        local,
      });
    };
    recognition.onerror = event => {
      settled = true;
      reject(new Error(ERROR_MESSAGES[event.error] || '語音辨識失敗，請再試一次'));
    };
    recognition.onend = () => {
      if (!settled) reject(new Error('沒有辨識到內容，請再說一次'));
    };
    try {
      recognition.start();
      options.onStart?.({ local });
    } catch (error) {
      reject(new Error('無法啟動麥克風', { cause: error }));
    }
  });
}
