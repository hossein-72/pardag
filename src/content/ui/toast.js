/**
 * اعلان‌های کوتاه و غیرمزاحم داخل صفحه چت.
 * پیام‌ها با textContent درج می‌شوند تا از تزریق HTML جلوگیری شود.
 */
export class ToastUI {
  static CONTAINER_ID = "bale-enc-toast-container";

  static ensureContainer() {
    let container = document.getElementById(this.CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = this.CONTAINER_ID;
      document.body.appendChild(container);
    }
    return container;
  }

  static show(message, type = "info", duration = 4500) {
    if (!message) return;

    const container = this.ensureContainer();
    const toast = document.createElement("div");
    toast.className = `bale-enc-toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("visible"));

    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }
}
