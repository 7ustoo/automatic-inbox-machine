/** Calendar date and hour in an IANA timezone, including daylight saving time. */
export function localDay(timestamp = Date.now(), timezone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}
