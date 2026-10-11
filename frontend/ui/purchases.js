// Supplier purchases at the Peak (phase 4 step 17): the pure parts of the purchases
// section, tested under Node. The section itself lives in inspect.js.

// "name × qty" or "name x 3" or "3 × name" lines into items; a line without a count is one.
export function parsePurchaseItems(text) {
  const items = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = /^(.*?)\s*[x×]\s*(\d+)$/i.exec(line);
    if (m) {
      items.push({ name: m[1].trim(), qty: Number(m[2]) });
      continue;
    }
    m = /^(\d+)\s*[x×]\s*(.+)$/i.exec(line);
    if (m) {
      items.push({ name: m[2].trim(), qty: Number(m[1]) });
      continue;
    }
    items.push({ name: line, qty: 1 });
  }
  return items.filter((it) => it.name && it.qty >= 1);
}

const usd = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : 'no data');

// One line per purchase row as the Peak shows it: the record, never a projection.
export function purchaseRowText(p) {
  const paid = p.status === 'paid' ? ` · paid ${usd(p.paidUsd)}${p.reconciliation ? ` · ${p.reconciliation === 'matched' ? 'reconciled' : p.reconciliation === 'no_source' ? 'no charge source' : p.reconciliation}` : ''}` : '';
  const held = ['requested', 'driving', 'handoff'].includes(p.status) ? ` · ${usd(p.amountUsd)} held` : ` · ${usd(p.amountUsd)} declared`;
  return `${p.id} · ${p.venture} · ${p.supplierHost || 'supplier'}${held} · ${p.status}${paid}${p.agentId ? ` · ${p.agentId}` : ''}`;
}

// The Rangers who may drive a purchase: in a zone with a Field office, never the Chief.
export function purchaseExecutors(layout) {
  const offices = new Set((layout.objects || []).filter((o) => o.kind === 'field_office').map((o) => o.roomId));
  return (layout.agents || []).filter((a) => offices.has(a.roomId) && (a.role || 'ranger') !== 'chief_ranger');
}
