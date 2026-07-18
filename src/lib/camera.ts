/** Abrir a webcam pelo id que o resto do app usa.
 *
 *  **O id do dshow e o do `MediaDeviceInfo` não são a mesma coisa.** O app
 *  inteiro identifica a câmera pelo nome que o ffmpeg quer (`video=<nome>`,
 *  vindo do `-list_devices`), enquanto o navegador identifica por um `deviceId`
 *  que é um hash. Não existe id comum entre os dois mundos: o casamento é por
 *  RÓTULO, e os rótulos só aparecem depois que a permissão de câmera é dada —
 *  daí a ordem obrigatória de pedir primeiro e escolher depois.
 *
 *  Isto morava dentro do `Preview.tsx` e virou módulo quando a janela de
 *  anotação passou a desenhar a câmera também (v0.7.0). Não é organização por
 *  gosto: eu escrevi a segunda chamada passando o nome do dshow direto num
 *  `deviceId: { exact: … }`, o `getUserMedia` recusou, e a gravação saiu com
 *  uma caixa vazia no lugar da câmera. A regra tem um dono só agora.
 */
export async function openCamera(id: string): Promise<MediaStream> {
  const first = await navigator.mediaDevices.getUserMedia({ video: true });
  const devices = await navigator.mediaDevices.enumerateDevices();
  const match =
    devices.find((d) => d.kind === "videoinput" && d.label === id) ??
    devices.find((d) => d.kind === "videoinput" && d.label.startsWith(id));
  // A câmera que já abriu é a certa (ou não há como saber): fica essa mesma.
  if (!match || first.getVideoTracks()[0]?.label === match.label) return first;
  // Era outra: solta a primeira antes de abrir a segunda — duas câmeras vivas
  // ao mesmo tempo travam o dispositivo em algumas webcams.
  for (const tr of first.getTracks()) tr.stop();
  return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: match.deviceId } } });
}
