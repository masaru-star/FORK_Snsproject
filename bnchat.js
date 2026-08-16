/** @param {NS} ns */
export async function main(ns) {
  const CONFIG_FILE = "bnchat_config.txt";
  const TABLE_USERS = 'users';
  const TABLE_POSTS = 'posts';
  const POLL_INTERVAL = 10000; // 10秒

  const WHITE = "\x1b[37m";
  const RESET = "\x1b[0m";

  function printWhite(msg) {
    ns.tprint(`${WHITE}${msg}${RESET}`);
  }

  let config = { url: "", key: "" };
  if (ns.fileExists(CONFIG_FILE)) {
    try {
      const fileData = ns.read(CONFIG_FILE);
      if (fileData) {
        config = JSON.parse(fileData);
      }
    } catch (e) {
      printWhite("【警告】設定ファイルの読み込みに失敗しました。");
    }
  }

  function generateUUID() {
    return crypto.randomUUID();
  }

  function getDeviceId() {
    const DEVICE_ID_FILE = "bnchat_device_id.txt";
    if (ns.fileExists(DEVICE_ID_FILE)) {
      return ns.read(DEVICE_ID_FILE);
    }
    const newId = generateUUID();
    ns.write(DEVICE_ID_FILE, newId, "w");
    return newId;
  }

  async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function request(endpoint, options = {}) {
    if (!config.url || !config.key) {
      printWhite("【エラー】Supabase URLとKeyが設定されていません。'setConfig' コマンドを実行してください。");
      return null;
    }

    const url = `${config.url}/rest/v1/${endpoint}`;
    const headers = {
      'apikey': config.key,
      'Authorization': `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...options.headers
    };
    
    try {
      const res = await fetch(url, { ...options, headers });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || res.statusText);
      }
      return res.status === 204 ? null : await res.json();
    } catch (e) {
      printWhite(`【API通信エラー】${e.message}`);
      return null;
    }
  }

  const command = ns.args[0];

  if (!command || command === "help") {
    printWhite("=== BNchat for Bitburner ===");
    printWhite("【初期設定】");
    printWhite("run bnchat.js setConfig <URL> <AnonKey>");
    printWhite("");
    printWhite("【使い方】");
    printWhite("ユーザー登録  : run bnchat.js register <名前> <パスワード>");
    printWhite("メッセージ投稿: run bnchat.js post <名前> <パスワード> \"投稿内容\"");
    printWhite("自動監視の開始: run bnchat.js start");
    printWhite("  ※監視を止める場合は「Active Scripts」からこのスクリプトをKillしてください。");
    return;
  }

  if (command === "setConfig") {
    const url = ns.args[1];
    const key = ns.args[2];
    if (!url || !key) {
      printWhite("【エラー】URLとKeyを指定してください。例: run bnchat.js setConfig https://... key...");
      return;
    }
    config = { url, key };
    ns.write(CONFIG_FILE, JSON.stringify(config), "w");
    printWhite("【成功】Supabaseの接続情報を設定ファイル(bnchat_config.txt)に保存しました。");
    return;
  }

  if (command === "register") {
    const name = ns.args[1];
    const password = ns.args[2];
    
    if (!name || !password) {
      printWhite("【エラー】ユーザー名とパスワードを指定してください。");
      return;
    }

    printWhite(`ユーザー '${name}' を登録中...`);

    const deviceId = getDeviceId();
    
    const isBanned = await request(`banned_devices?device_id=eq.${deviceId}`);
    if (isBanned && isBanned.length > 0) {
      printWhite("【エラー】このデバイスからのアクセスは制限されています。");
      return;
    }
    
    const existing = await request(`${TABLE_USERS}?name=eq.${encodeURIComponent(name)}&select=name`);
    if (existing && existing.length > 0) {
      printWhite(`【エラー】ユーザー名 '${name}' は既に使われています。`);
      return;
    }

    const hashedPassword = await hashPassword(password);

    const result = await request(TABLE_USERS, {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ name: name, password: hashedPassword, device_id: deviceId })
    });

    if (result) {
      printWhite("【成功】ユーザー登録が完了しました！");
    }
    return;
  }

  if (command === "post") {
    const name = ns.args[1];
    const password = ns.args[2];
    const message = ns.args[3];
    
    if (!name || !password || !message) {
      printWhite("【エラー】引数が足りません。メッセージは \" \" で囲んでください。");
      printWhite("例: run bnchat.js post ユーザー名 パスワード \"こんにちは！\"");
      return;
    }

    if (message.length > 150) {
        printWhite("【エラー】メッセージは150文字以内で入力してください。");
        return;
    }

    const deviceId = getDeviceId();

    const isBanned = await request(`banned_devices?device_id=eq.${deviceId}`);
    if (isBanned && isBanned.length > 0) {
      printWhite("【エラー】このデバイスからのアクセスは制限されています。");
      return;
    }

    const users = await request(`${TABLE_USERS}?name=eq.${encodeURIComponent(name)}&select=*`);
    if (!users || users.length === 0) {
      printWhite('【エラー】ユーザーが見つかりません。');
      return;
    }
    
    const hashedPassword = await hashPassword(password);
    if (users[0].password !== hashedPassword) {
      printWhite('【エラー】パスワードが間違っています。');
      return;
    }

    if (users[0].is_banned) {
      printWhite('【エラー】このアカウントは凍結されています。');
      return;
    }

    const result = await request(TABLE_POSTS, {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ user_id: users[0].id, device_id: deviceId, message: message })
    });

    if (result) {
      printWhite('【送信成功】メッセージを投稿しました。');
    }
    return;
  }

  if (command === "start") {
    printWhite("[システム] 10秒おきの新着監視を開始しました。ターミナルに新着が表示されます。");
    let lastCheckTime = new Date().toISOString();

    while (true) {
      await ns.sleep(POLL_INTERVAL);
      const endpoint = `${TABLE_POSTS}?created_at=gt.${encodeURIComponent(lastCheckTime)}&select=*,users(name)&order=created_at.asc`;
      const newPosts = await request(endpoint);

      if (newPosts && newPosts.length > 0) {
        for (const p of newPosts) {
          const time = new Date(p.created_at).toLocaleTimeString();
          printWhite(`[新着 ${time}] ${p.users.name}`);
          printWhite(`> ${p.message}`);
        }
        lastCheckTime = newPosts[newPosts.length - 1].created_at;
      }
    }
  }
}
