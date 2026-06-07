/**
 * Cüzdanın gerçek açık pozisyon vs işlem sayısını doğrular.
 * 500 = analiz scriptinin çektiği "son X işlem" limiti, açık pozisyon sayısı değil.
 *
 * Kullanım: node src/verify_whale_counts.js [wallet]
 * Örnek:   node src/verify_whale_counts.js 0x63ce342161250d705dc0b16df89036c8e5f9ba9a
 */

const WALLET = process.argv[2] || "0x63ce342161250d705dc0b16df89036c8e5f9ba9a";
const TRADES_LIMIT = 500;

async function fetchPositions(user) {
  const url = `https://data-api.polymarket.com/positions?user=${user}&limit=500`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("Pozisyonlar alınamadı:", e.message);
    return [];
  }
}

async function fetchTrades(user, limit) {
  const url = `https://data-api.polymarket.com/trades?user=${user}&limit=${limit}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("İşlemler alınamadı:", e.message);
    return [];
  }
}

async function main() {
  console.log("Cüzdan:", WALLET);
  console.log("");

  const [positions, trades] = await Promise.all([
    fetchPositions(WALLET),
    fetchTrades(WALLET, TRADES_LIMIT)
  ]);

  const uniqueTx = new Set((trades || []).map((t) => t.transactionHash).filter(Boolean));

  console.log("--- API sonuçları ---");
  console.log("Açık pozisyon sayısı (Current Positions):", positions.length);
  console.log("Son işlem sayısı (trades, limit=" + TRADES_LIMIT + "):", trades.length);
  console.log("Bunların tekil işlem (tx) sayısı:", uniqueTx.size);
  console.log("");
  console.log("--- Açıklama ---");
  console.log("• Ekrandaki '48 aktif pozisyon' = açık bahisler (positions).");
  console.log("• '500' bizim analiz scriptinde kullandığımız limit: API'den en fazla 500 adet 'trade' (işlem kaydı) çekiyoruz.");
  console.log("• Yani 500 = 'son 500 işlemi getir' limiti, bu kişinin 500 açık pozisyonu olduğu anlamına gelmez.");
  console.log("• Bu cüzdanın gerçek açık pozisyon sayısı:", positions.length);
}

main();
