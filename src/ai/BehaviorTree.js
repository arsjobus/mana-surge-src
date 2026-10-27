/** Small behavior-tree combinators. Nodes receive and may update a blackboard. */
export function Selector(...children) {
  return (blackboard) => {
    for (const child of children) {
      const result = child(blackboard);
      if (result) return result;
    }
    return null;
  };
}

export function Sequence(...children) {
  return (blackboard) => {
    let result = null;
    for (const child of children) {
      result = child(blackboard);
      if (!result) return null;
    }
    return result;
  };
}

export const Condition = (predicate) => (blackboard) => predicate(blackboard) ? true : null;
export const Action = (action) => (blackboard) => action(blackboard);
