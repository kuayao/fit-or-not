export function pendingPackingReminders(startOn: string) {
  return startOn ? [1, 2].filter(days => Date.parse(`${startOn}T19:00:00+08:00`) - days * 86400000 > Date.now()).length : 0;
}

export async function requestPackingSubscription(templateId: string) {
  try {
    const result = await wx.requestSubscribeMessage({ tmplIds: [templateId] });
    return ['accept', 'acceptWithAlert'].includes(result[templateId]) ? 1 : 0;
  } catch {
    return 0;
  }
}
