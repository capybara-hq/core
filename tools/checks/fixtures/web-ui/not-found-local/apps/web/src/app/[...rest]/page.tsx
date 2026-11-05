function notFound(): never {
  throw new Error("nope");
}

export default function CatchAll(): never {
  notFound();
}
