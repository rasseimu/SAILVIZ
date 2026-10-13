// server/domain/rateLimit.js
// メモリ上のスライディングウィンドウ回数制限(設計書 v2 §4.3「ログインに回数制限をかける」)。
// マシンは1台(Fly 1台構成)なので共有ストアは要らない。再起動で数え直しになる(許容)。
// 時刻は引数で受ける(テストしやすさ)。失敗だけを record し、成功したら clear する使い方を想定。
export function createRateLimiter({ max, windowMs, maxKeys = 10_000 }) {
  const hits = new Map(); // key -> 昇順の epoch ms 配列

  const live = (key, now) => {
    const arr = hits.get(key);
    if (!arr) return [];
    const fresh = arr.filter((t) => t > now - windowMs);
    if (fresh.length) hits.set(key, fresh); else hits.delete(key);
    return fresh;
  };

  return {
    // 上限に達していれば { limited: true, retryAfterMs }。
    check(key, now = Date.now()) {
      const arr = live(key, now);
      if (arr.length < max) return { limited: false, retryAfterMs: 0 };
      return { limited: true, retryAfterMs: Math.max(0, arr[arr.length - max] + windowMs - now) };
    },
    record(key, now = Date.now()) {
      const arr = live(key, now);
      arr.push(now);
      hits.delete(key); hits.set(key, arr); // 末尾へ移す(溢れたとき、最近動いたキーを残し、古いものから捨てる)
      if (hits.size > maxKeys) { // 肥大化の防止: 期限切れのキーを掃除し、それでも多ければ古いものから捨てる
        for (const k of [...hits.keys()]) live(k, now);
        while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      }
    },
    clear(key) { hits.delete(key); },
    get size() { return hits.size; },
  };
}
