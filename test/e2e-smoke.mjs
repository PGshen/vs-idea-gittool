export async function run({ shot, sleep }) {
  await sleep(2000);
  await shot('smoke');
}
