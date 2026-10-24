async function main() {
  const res = await fetch("https://api.bitso.com/v3/order_book/?book=usd_mxn");
  const data = await res.json();
  console.log("USD/MXN Orderbook Top Bids/Asks:");
  console.log("Bids:", data.payload.bids.slice(0, 3));
  console.log("Asks:", data.payload.asks.slice(0, 3));

  const booksRes = await fetch("https://api.bitso.com/v3/available_books/");
  const books = await booksRes.json();
  const usdMxn = books.payload.find((b: any) => b.book === "usd_mxn");
  console.log("\nReglas oficiales del libro usd_mxn en Bitso:");
  console.log(JSON.stringify(usdMxn, null, 2));
}

main();
