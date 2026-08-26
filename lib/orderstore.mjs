// dsh-gpu-monitor: 分组显示顺序持久化（{o: string[], t: 时间戳}）。
// 宿主插件与 sidecar 共用；file 为空 = 仅内存（不落盘）。
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export class OrderStore {
  /**
   * @param {string} file 持久化文件路径；空串 = 仅内存
   * @param {(...a: any[]) => void} [log]
   */
  constructor(file = "", log = () => {}) {
    this.file = file;
    this.log = log;
    this.state = { o: [], t: 0 };
    if (file) this.load();
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw && Array.isArray(raw.o) && Number.isFinite(raw.t)) {
        this.state = { o: raw.o.filter((x) => typeof x === "string"), t: raw.t };
      }
    } catch {}
  }

  /** 原子写盘（tmp + rename）。失败返回 false 并记录日志。 */
  save() {
    if (!this.file) return true;
    try {
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this.log("保存顺序文件失败:", String(e));
      return false;
    }
  }

  /**
   * 时间戳不低于当前值才接受（防旧客户端覆盖新顺序）。
   * @param {string[]} o
   * @param {number} t
   * @returns {boolean} 是否接受
   */
  set(o, t) {
    if (!Array.isArray(o) || !Number.isFinite(t) || t < this.state.t) return false;
    this.state = { o: o.filter((x) => typeof x === "string"), t };
    this.save();
    return true;
  }

  get() {
    return this.state;
  }
}
