const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

let isProcessing = false;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (isProcessing) {
    return res.status(200).json({
      success: true,
      count: 0,
      emails: [],
      notice: "正在处理邮件，请稍后重试。"
    });
  }
  isProcessing = true;

  const client = new ImapFlow({
    host: 'imap.qq.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.QQ_EMAIL,
      pass: process.env.QQ_AUTH_CODE
    },
    logger: false,
    socketTimeout: 10000
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let messages = [];

    try {
      // 不限制unseen；searchAll获取全部邮件UID，按UID倒序拿【最新1封】
      const allUids = await client.search({ all: true });
      if (allUids && allUids.length > 0) {
        // UID降序，取收件箱最新的一条
        allUids.sort((a, b) => b - a);
        const latestUid = allUids[0];

        // 读取最新一封
        for await (const message of client.fetch(latestUid, {
          envelope: true,
          source: true
        }, { uid: true })) {
          const parsed = await simpleParser(message.source);
          messages.push({
            subject: message.envelope.subject || '无主题',
            from: message.envelope.from?.[0]?.address || '未知发件人',
            date: message.envelope.date,
            content: (parsed.text || '（无文字正文）').trim().slice(0, 3000)
          });
        }

        // ✅读取解析成功后，强制标记该封为已读
        await client.messageFlagsAdd(latestUid, ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }

    await client.logout();

    if (messages.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        emails: [],
        notice: "收件箱为空，没有任何邮件。"
      });
    }

    return res.status(200).json({ success: true, count: messages.length, emails: messages });

  } catch (err) {
    console.error('IMAP ERROR:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    try {
      await client.logout();
    } catch (_) {}
    isProcessing = false;
  }
};
