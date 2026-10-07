/**
 * BUG-10 — every text an alert showed from now on: an alert put in, and a new text in one already
 * there — React rewrites a text it rendered in place — one taken back at once included: "never drawn
 * there" is not the same as "not there any more". Each time it was shown: a sentence said again is
 * reported again. `where`: the screen's alerts (outside any dialog) or a sheet's (inside a dialog).
 *
 * The observer hands its changes over in batches (two renders in one `act` flush land in one), so a
 * batch is replayed backwards from the tree as it is now: the old values and the nodes each change
 * carries give back what every alert showed right after each change. An alert left empty says
 * nothing and is not reported. Not seen: an element made an alert through its role attribute (no
 * alert here is).
 *
 * A probe's "not observed" is evidence only once it has been seen to report the thing. Positive
 * controls: the screen's — "alertsDrawn (positive control)" (session-refusal-surfacing); a sheet's —
 * "C1's recorder (positive control)" (session-edit-window-wiring).
 */
export function alertsDrawn(where: "screen" | "dialog" = "screen") {
  const texts: string[] = [];
  const observer = new MutationObserver((records) => {
    // The tree right after the record being replayed — the later ones undone, back from now.
    const values = new Map<Node, string | null>();
    const kids = new Map<Node, Node[]>();
    const parents = new Map<Node, Node | null>();
    const childrenOf = (node: Node) => {
      if (!kids.has(node)) kids.set(node, [...node.childNodes]);
      return kids.get(node)!;
    };
    const textOf = (node: Node): string =>
      node.nodeType === Node.TEXT_NODE
        ? ((values.has(node) ? values.get(node) : node.nodeValue) ?? "")
        : node.nodeType === Node.ELEMENT_NODE
          ? childrenOf(node).map(textOf).join("")
          : "";
    const role = (node: Node) => (node instanceof Element ? node.getAttribute("role") : null);
    /** The alert `node` is (or is in), if that is on the page and where this recorder watches. */
    const watchedAlert = (node: Node) => {
      let alert: Node | null = null;
      let inDialog = false;
      let at: Node | null = node;
      for (; at && at !== document; at = parents.has(at) ? parents.get(at)! : at.parentNode) {
        if (role(at) === "dialog") inDialog = true;
        if (!alert && role(at) === "alert") alert = at;
      }
      return at === document && inDialog === (where === "dialog") ? alert : null;
    };
    const alertsIn = (node: Node): Node[] => [
      ...(role(node) === "alert" ? [node] : []),
      ...childrenOf(node).flatMap(alertsIn),
    ];
    const replayed: string[][] = [];
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      const shown = [...record.addedNodes]
        .flatMap(alertsIn)
        .filter((alert) => watchedAlert(alert) === alert)
        .map(textOf); // alerts this change put in
      const around = watchedAlert(record.target); // an alert this change rewrote from inside
      const after = around ? textOf(around) : null;
      if (record.type === "characterData") values.set(record.target, record.oldValue);
      else {
        const list = childrenOf(record.target);
        for (const node of record.addedNodes) {
          list.splice(list.indexOf(node), 1);
          parents.set(node, null);
        }
        const at = record.previousSibling ? list.indexOf(record.previousSibling) + 1 : 0;
        list.splice(at, 0, ...record.removedNodes);
        for (const node of record.removedNodes) parents.set(node, record.target);
      }
      if (around && after !== textOf(around)) shown.push(after!);
      replayed[i] = shown;
    }
    texts.push(...replayed.flat().filter((text) => text !== ""));
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
  });
  return { texts, stop: () => observer.disconnect() };
}
