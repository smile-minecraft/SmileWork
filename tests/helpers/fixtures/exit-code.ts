const code = Number(process.argv[2] ?? "1");
console.error(`exit ${code}`);
process.exit(code);
