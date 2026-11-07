const bytes = Number(process.argv[2] ?? "1000000");
process.stdout.write("x".repeat(bytes));
