/** Build a three-seat controller roster for a host-authoritative match. */
export function createSeatRoster({ hostSeat, guestSeats = [], cpuSeats = [] }) {
  const seats = [0, 1, 2];
  if (!Number.isInteger(hostSeat) || !seats.includes(hostSeat)) return null;
  if (!Array.isArray(guestSeats) || !Array.isArray(cpuSeats)) return null;

  const roster = seats.map(seat => ({ seat, controller: 'cpu' }));
  roster[hostSeat] = { seat: hostSeat, controller: 'host' };
  const assigned = new Set([hostSeat]);
  for (const [controller, assignedSeats] of [['guest', guestSeats], ['cpu', cpuSeats]]) {
    for (const seat of assignedSeats) {
      if (!Number.isInteger(seat) || !seats.includes(seat) || assigned.has(seat)) return null;
      assigned.add(seat);
      roster[seat] = { seat, controller };
    }
  }
  return roster;
}
