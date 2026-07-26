import { useEffect, useState } from "react";
import { X, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { toast } from "./toast";
import s from "./Toaster.module.css";

const ICON = {
  ok:    <CheckCircle2  size={13} strokeWidth={2} />,
  warn:  <AlertTriangle size={13} strokeWidth={2} />,
  error: <XCircle       size={13} strokeWidth={2} />,
};

export default function Toaster() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    return toast._subscribe((item) => {
      setItems(prev => [...prev, { ...item, exiting: false }]);
      setTimeout(() => exit(item.id), item.duration);
    });
  }, []);

  function exit(id) {
    setItems(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 310);
  }

  if (!items.length) return null;

  return (
    <div className={s.toaster}>
      {items.map(item => (
        <div
          key={item.id}
          className={`${s.toast} ${s[item.level]} ${item.exiting ? s.exit : s.enter}`}
        >
          <span className={`${s.icon} ${s[item.level + "Icon"]}`}>
            {ICON[item.level]}
          </span>
          <span className={s.msg}>{item.text}</span>
          <button className={s.close} onClick={() => exit(item.id)}>
            <X size={11} strokeWidth={2.5} />
          </button>
        </div>
      ))}
    </div>
  );
}
