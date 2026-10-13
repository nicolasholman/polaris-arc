export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
export type InstallState = { prompt: InstallPromptEvent | null; installed: boolean };

/** Keeps the browser's one-use install prompt across route changes. */
export function createInstallStore() {
  let state: InstallState = { prompt: null, installed: false };
  const listeners = new Set<() => void>();
  const update = (next: InstallState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    consume() { update({ ...state, prompt: null }); },
    capture(target: EventTarget) {
      const prompt = (event: Event) => {
        event.preventDefault();
        update({ prompt: event as InstallPromptEvent, installed: false });
      };
      const installed = () => update({ prompt: null, installed: true });
      target.addEventListener("beforeinstallprompt", prompt);
      target.addEventListener("appinstalled", installed);
      return () => {
        target.removeEventListener("beforeinstallprompt", prompt);
        target.removeEventListener("appinstalled", installed);
      };
    },
  };
}
export const installStore = createInstallStore();
export const serverInstallState: InstallState = { prompt: null, installed: true };
