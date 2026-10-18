const nodemailer = require('nodemailer');

module.exports = async (req, res) =>{
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { subject, content, sender, senderName, sender_name, sendemame } = req.body || req.query || {};

  if (!subject || !content) {
    return res.status(400).json({ error: '缺少 subject 或 content 参数' });
  }

  const displayName = sender || senderName || sender_name || sendemame || 'AI Companion';

  const transporter = nodemailer.createTransport({
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.QQ_EMAIL,
      pass: process.env.QQ_AUTH_CODE
    }
  });

  try {
    const info = await transporter.sendMail({
      from: `"${displayName}" <${process.env.QQ_EMAIL}>`,
      to: process.env.TO_EMAIL || process.env.QQ_EMAIL,
      subject: subject,
      text: content
    });

    return res.status(200).json({ success: true, messageId: info.messageId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
