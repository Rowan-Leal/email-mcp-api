const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// 单实例并发锁，避免同时发起多个IMAP连接导致熔断/抢邮件
let isProcessing = false;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 并发拦截：上一次请求未完成时直接返回，避免重复连接IMAP触发限流
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
    socketTimeout: 10000 // 10秒超时，防止连接卡死占用资源
  });

  try {
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    let messages = [];

    try {
      // 1. 检索收件箱里的未读邮件 (unseen)，返回结果为UID
      let uids = await client.search({ unseen: true });

      if (uids && uids.length > 0) {
        // UID按降序排列，确保取到最新的3封
        uids.sort((a, b) => b - a);
        let targetUids = uids.slice(0, 3);
        let range = targetUids.join(',');

        // 2. 拉取并解析邮件（全程仅读取，不标记已读）
        for await (let message of client.fetch(range, { envelope: true, source: true }, { uid: true })) {
          let parsed = await simpleParser(message.source);
          messages.push({
            subject: message.envelope.subject || '无主题',
            from: message.envelope.from?.[0]?.address || '未知发件人',
            date: message.envelope.date,
            content: (parsed.text || '（无文字正文）').trim().slice(0, 500)
          });
        }
        messages.reverse();

        // ✅ 全部解析成功后，再统一标记为已读
        // 只要解析环节出错，就不会执行标记，彻底避免邮件被"吞"
        if (messages.length > 0) {
          await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();

    // 3. 如果没有未读邮件，明确告知
    if (messages.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        emails: [],
        notice: "当前没有收到新的未读邮件（之前的邮件已阅读过，对方尚未回复）。"
      });
    }

    return res.status(200).json({ success: true, count: messages.length, emails: messages });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    // 兜底：无论成功失败，都释放锁并关闭连接
    try {
      await client.logout();
    } catch (_) {}
    isProcessing = false;
  }
};
