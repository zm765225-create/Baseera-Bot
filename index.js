require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const PDFParser = require('pdf2json');
const https = require('https');
const http = require('http');

// ── التجهيز للسيرفر (Render Health Check) ──
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Baseera Academic Bot is Live!\n');
});
server.listen(port, () => console.log(`Server running on port ${port}`));

// ── الإعدادات الأساسية ──
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const usersDb = {};

// ── المساعدات ──
function getUser(telegramId) { return usersDb[telegramId] || null; }
function upsertUser(telegramId, updates) {
  if (!usersDb[telegramId]) usersDb[telegramId] = { telegram_id: telegramId };
  usersDb[telegramId] = { ...usersDb[telegramId], ...updates };
  return usersDb[telegramId];
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function extractPdfText(buffer) {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser(this, 1);
    pdfParser.on("pdfParser_dataError", errData => reject(errData.parserError));
    pdfParser.on("pdfParser_dataReady", pdfData => resolve(pdfParser.getRawTextContent()));
    pdfParser.parseBuffer(buffer);
  });
}

const GUIDE_MESSAGE = `*كيفية الاستخدام:*\n\n1️⃣ قم برفع ملف المنهج (PDF).\n2️⃣ انتظر تأكيد استلام ومعالجة الملف.\n3️⃣ ابدأ بطرح أسئلتك الأكاديمية.`;

// ── التعامل مع الأوامر ──
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  upsertUser(telegramId, { state: 'awaiting_name', name: '', pdf_text: '' });
  await bot.sendMessage(chatId, 'أهلاً بك في "بصيرة"، المساعد الأكاديمي لمادة أسس غذاء وتغذية. لكي أتمكن من مساعدتك بشكل شخصي، فضلاً أخبرني باسمك؟');
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const user = getUser(telegramId);

  if (!user || user.state === 'awaiting_name') {
    return bot.sendMessage(chatId, user ? 'فضلاً أخبرني باسمك أولاً.' : 'يرجى إرسال /start لبدء الاستخدام.');
  }

  const doc = msg.document;
  if (doc.mime_type !== 'application/pdf') {
    return bot.sendMessage(chatId, `عذراً يا ${user.name}، يُرجى رفع ملف بصيغة PDF فقط.`);
  }

  await bot.sendMessage(chatId, `جارٍ معالجة الملف يا ${user.name}، يرجى الانتظار...`);

  try {
    const fileInfo = await bot.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    const buffer = await downloadBuffer(fileUrl);
    const pdfText = await extractPdfText(buffer);
    const truncatedText = pdfText.slice(0, 8000);

    upsertUser(telegramId, { pdf_text: truncatedText });
    await bot.sendMessage(chatId, `تم استلام ومعالجة المنهج بنجاح يا ${user.name}. أنا جاهز لأسئلتك الآن.`);
  } catch (err) {
    console.error('PDF Error:', err);
    await bot.sendMessage(chatId, `حدث خطأ في معالجة الملف. يرجى المحاولة مرة أخرى.`);
  }
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/') || msg.document) return;
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const text = msg.text.trim();
  let user = getUser(telegramId);

  if (!user) return bot.sendMessage(chatId, 'يرجى إرسال /start أولاً.');

  if (user.state === 'awaiting_name') {
    upsertUser(telegramId, { name: text, state: 'ready' });
    await bot.sendMessage(chatId, `سعدت بمعرفتك يا ${text}. أنا "بصيرة"، مرجعك الأكاديمي في المنهج.`);
    await bot.sendMessage(chatId, GUIDE_MESSAGE, { parse_mode: 'Markdown' });
    return;
  }

  if (!user.pdf_text) {
    return bot.sendMessage(chatId, `فضلاً يا ${user.name}، ارفع ملف المنهج أولاً لنبدأ الشرح.`);
  }

  await bot.sendChatAction(chatId, 'typing');

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `أنت "بصيرة"، مساعد أكاديمي خبير في مادة أسس غذاء وتغذية بجامعة عين شمس.
          خاطب الطالب دائماً باسمه: ${user.name}.
          التزم بأسلوب أكاديمي رصين ومنظم (نقاط عريضة).
          أجب فقط بناءً على محتوى المنهج التالي:\n${user.pdf_text}`
        },
        { role: 'user', content: text }
      ],
      temperature: 0.3,
    });
    await bot.sendMessage(chatId, completion.choices[0]?.message?.content || 'عذراً، لم أستطع صياغة إجابة.');
  } catch (err) {
    console.error('Groq Error:', err);
    await bot.sendMessage(chatId, `نعتذر يا ${user.name}، واجهت مشكلة في الاتصال.`);
  }
});

console.log('Baseera Bot is running...');

