const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const CONFIG = {
  parseCount: 5,                    // 只解析这么多封
  returnLimit: 3,                   // 最多返回多少封未读
  maxContent: 3000,                 // 单封正文字数上限
  maxSourceLength: 1024 * 1024,     // 单封原文最大抓取字节
  markAsRead: true,
  lockTimeout: 25000,
  socketTimeout: 20000
};

let isProcessing = false;

const htmlToText = (html) => String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const toSet = (flags) => {
  if (flags instanceof Set) return flags;
  if (Array.isArray(flags)) return new Set(flags);
  return new Set();
};

const hasSeen = (flags) =>
  [...flags].some((f) => String(f).toLowerCase() === '\\seen');

// unseenSet 只在服务器没返回 flags 时用于兜底判读
const buildEmail = async (msg, unseenSet) => {
  const hasFlagInfo = msg.flags !== undefined && msg.flags !== null;
  const flags = toSet(msg.flags);
  const seen = hasFlagInfo ? hasSeen(flags) : !unseenSet.has(msg.uid);

  let parsed = {};
  let parseError = null;
  try {
    parsed = await simpleParser(msg.source);
  } catch (e) {
    parseError = e.message;
  }
  const text = (parsed.text || htmlToText(parsed.html) || '').trim();

  return {
    uid: msg.uid,
    seen,
    flags: [...flags],
    subject: msg.envelope?.subject || parsed.subject || '无主题',
    from: msg.envelope?.from?.[0]?.address || '未知发件人',
    fromName: msg.envelope?.from?.[0]?.name || '',
    date: msg.envelope?.date || msg.internalDate || parsed.date || null,
    content: (text ? text.slice(0, CONFIG.maxContent) : '（无文字正文）'),
    ...(parseError ? { parseError } : {})
  };
};

// 把 UID 列表拆成连续段，避免 a:z 跨大区间时把中间邮件全抓一遍
const groupRanges = (uids) => {
  const groups = [];
  for (const uid of uids) {
    const last = groups[groups.length - 1];
    if (last && uid === last[1] + 1) last[1] = uid;
    else groups.push([uid, uid]);
  }
  return groups;
};

const fetchQuery = () => ({
  envelope: true,
  flags: true,
  internalDate: true,
  source: { maxLength: CONFIG.maxSourceLength },
  uid: true
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const debug = /^(1|true|yes)$/i.test(
    String(req.query?.debug ?? req.body?.debug ?? '')
  );

  if (isProcessing) {
    return res.status(200).json({
      success: true,
      busy: true,
      count: 0,
      emails: [],
      notice: '上一批邮件仍在处理中，请稍后重试。'
    });
  }
  isProcessing = true;
  const lockTimer = setTimeout(() => { isProcessing = false; }, CONFIG.lockTimeout);

  const client = new ImapFlow({
    host: 'imap.qq.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.QQ_EMAIL,
      pass: process.env.QQ_AUTH_CODE
    },
    logger: false,
    socketTimeout: CONFIG.socketTimeout
  });

  const meta = {
    mailboxTotal: 0,
    unseenOnServer: null,
    poolUids: [],
    parsed: 0,
    unreadInPool: 0,
    returned: 0,
    judgedBy: null
  };

  try {
    await client.connect();

    const mailboxLock = await client.getMailboxLock('INBOX');
    try {
      // 1) 全部 UID（不依赖 SORT 扩展，QQ 不一定支持）
      const allUids = (await client.search({ all: true }, { uid: true })) || [];
      meta.mailboxTotal = allUids.length;

      if (allUids.length === 0) {
        return res.status(200).json({
          success: true, count: 0, emails: [],
          notice: '收件箱为空，没有任何邮件。',
          ...(debug ? { meta } : {})
        });
      }
      allUids.sort((a, b) => a - b);

      // 2) 服务端未读（双路之一）
      let serverUnseen = [];
      try {
        serverUnseen = (await client.search({ seen: false }, { uid: true })) || [];
        meta.unseenOnServer = serverUnseen.length;
      } catch (e) {
        meta.unseenSearchError = e.message;   // 不支持也不影响主流程
      }
      serverUnseen.sort((a, b) => b - a);

      // 3) 候选池：未读优先填，剩余名额用最新几封补齐，总数 <= parseCount
      const pool = [];
      const addUid = (uid) => {
        if (pool.length >= CONFIG.parseCount) return;
        if (!pool.includes(uid)) pool.push(uid);
      };
      serverUnseen.forEach(addUid);
      [...allUids].reverse().forEach(addUid);

      const poolUids = pool.sort((a, b) => a - b);
      meta.poolUids = poolUids;

      const poolSet = new Set(poolUids);
      const unseenSet = new Set(serverUnseen);
      const parsedList = [];

      // 4) 先解析（BODY.PEEK，不会误标已读），按连续段分批抓
      for (const [from, to] of groupRanges(poolUids)) {
        for await (const msg of client.fetch(
          from === to ? String(from) : `${from}:${to}`,
          fetchQuery(),
          { uid: true }
        )) {
          if (!poolSet.has(msg.uid)) continue;
          parsedList.push(await buildEmail(msg, unseenSet));
        }
      }
      meta.parsed = parsedList.length;

      // 5) 解析完再判断未读，取最新 N 封
      parsedList.sort((a, b) => b.uid - a.uid);
      let unread = parsedList.filter((m) => !m.seen);
      meta.unreadInPool = unread.length;
      meta.judgedBy = 'fetch-flags';

      // 6) 兜底：池内全判已读，但服务端说未读
      if (unread.length === 0 && serverUnseen.length > 0) {
        meta.judgedBy = 'server-unseen-fallback';

        // 冲突候选：SEARCH 说未读、但 flags 说已读的池内邮件
        const conflicts = parsedList
          .filter((m) => unseenSet.has(m.uid))
          .sort((a, b) => b.uid - a.uid)
          .slice(0, CONFIG.returnLimit);

        // 池外的未读：逐封精读，真未读优先
        const outsiders = serverUnseen
          .filter((u) => !poolSet.has(u))
          .slice(0, CONFIG.returnLimit);

        for (const uid of outsiders) {
          const one = await client.fetchOne(uid, fetchQuery(), { uid: true });
          if (!one) continue;
          const item = await buildEmail(one, unseenSet);
          if (!item.seen) {
            unread.push(item);
          } else if (conflicts.length < CONFIG.returnLimit) {
            conflicts.push(item);
          }
        }

        // 还是没找到：宁可返回也不静默回空
        if (unread.length === 0 && conflicts.length > 0) {
          unread = conflicts;
          meta.flagConflict = true;
        }
        unread.sort((a, b) => b.uid - a.uid);
      }

      const emails = unread.slice(0, CONFIG.returnLimit);
      meta.returned = emails.length;

      // 7) 真的没有未读 → 二次确认后如实回空
      if (emails.length === 0) {
        try {
          const st = await client.status('INBOX', { messages: true, unseen: true });
          meta.unseenOnServer = st?.unseen ?? meta.unseenOnServer;
        } catch (_) {}

        const reallyEmpty = meta.unseenOnServer === 0;
        return res.status(200).json({
          success: true,
          count: 0,
          emails: [],
          notice: reallyEmpty
            ? '已确认：当前没有未读邮件。'
            : '未找到未读邮件（服务端报告有未读，但标志位不一致，请查看 meta 排查）。',
          ...(debug ? { meta } : {})
        });
      }

      // 8) 只标记返回的这几封
      if (CONFIG.markAsRead) {
        try {
          await client.messageFlagsAdd(emails.map((m) => m.uid), ['\\Seen'], { uid: true });
        } catch (e) {
          meta.markReadError = e.message;
          for (const m of emails) {
            try {
              await client.messageFlagsAdd(m.uid, ['\\Seen'], { uid: true });
            } catch (_) {}
          }
        }
      }

      return res.status(200).json({
        success: true,
        count: emails.length,
        markedAsRead: CONFIG.markAsRead,
        emails,
        ...(debug ? { meta } : {})
      });

    } finally {
      mailboxLock.release();
    }

  } catch (err) {
    console.error('IMAP ERROR:', err);
    return res.status(500).json({
      success: false,
      count: 0,
      emails: [],
      error: err.message,
      ...(debug ? { meta } : {})
    });
  } finally {
    clearTimeout(lockTimer);
    isProcessing = false;
    if (client.usable) {
      try { await client.logout(); } catch (_) {}
    }
  }
};
