const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

let isProcessing = false;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 并发控制：单实例避免重复连接IMAP
  if (isProcessing) {
    return res.status(200).json({
      success: true,
      count: 0,
      emails: [],
      notice: "正在处理邮件，请稍后重试。"
    });
  }
  isProcessing = true;
  // 兜底超时：15秒后强制释放锁，防止函数异常终止导致永久卡死
  const lockTimer = setTimeout(() => { isProcessing = false; }, 15000);

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
      // 全程使用UID模式获取所有邮件ID
      // UID是邮件的唯一固定标识，不会随邮件状态/位置变化而改变
      const allUids = await client.search({ all: true }, { uid: true });
      
      if (allUids && allUids.length > 0) {
        // UID严格递增，降序排序后第一个就是收件箱最新的邮件
        allUids.sort((a, b) => b - a);
        const latestUid = allUids[0];

        // 按UID精准读取邮件内容
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

        // 按UID精准标记为已读
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

    return res.status(200).json({ 
      success: true, 
      count: messages.length, 
      emails: messages 
    });

  } catch (err) {
    console.error('IMAP ERROR:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    // 兜底断开连接，忽略断开时的异常
    try {
      await client.logout();
    } catch (_) {}
    // 清理定时器并释放锁
    clearTimeout(lockTimer);
    isProcessing = false;
  }
};
