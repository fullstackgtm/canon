type ToastApi = typeof import("sonner").toast;

async function getToast(): Promise<ToastApi> {
  const sonner = await import("sonner");
  return sonner.toast;
}

export const toast = {
  success: async (...args: Parameters<ToastApi["success"]>) => {
    const api = await getToast();
    return api.success(...args);
  },
  error: async (...args: Parameters<ToastApi["error"]>) => {
    const api = await getToast();
    return api.error(...args);
  },
  info: async (...args: Parameters<ToastApi["info"]>) => {
    const api = await getToast();
    return api.info(...args);
  },
  warning: async (...args: Parameters<ToastApi["warning"]>) => {
    const api = await getToast();
    return api.warning(...args);
  },
  message: async (...args: Parameters<ToastApi["message"]>) => {
    const api = await getToast();
    return api.message(...args);
  },
};
