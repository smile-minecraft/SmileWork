const ms = Number(process.argv[2] ?? "5000");
await Bun.sleep(ms);
console.log("done");
