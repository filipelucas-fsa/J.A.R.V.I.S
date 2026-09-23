// Relógio controlável: setTimer/setTicker só disparam quando o teste chama advance().
export function createClock(start = 1_000_000) {
  let time = start;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn, every }

  const clock = {
    now: () => time,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn, every: null });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    setTicker(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn, every: ms });
      return id;
    },
    clearTicker(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        let dueId = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (dueId === null || timer.at < timers.get(dueId).at)) dueId = id;
        }
        if (dueId === null) break;
        const timer = timers.get(dueId);
        time = timer.at;
        if (timer.every) timer.at += timer.every;
        else timers.delete(dueId);
        timer.fn();
      }
      time = end;
    },
    get pending() {
      return timers.size;
    },
  };
  return clock;
}
