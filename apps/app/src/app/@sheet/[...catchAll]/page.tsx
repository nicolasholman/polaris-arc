/**
 * Any other page closes the sheet: without this, the slot would keep showing
 * the last sheet after a link inside it navigated to a tab.
 */
export default function NoSheet() {
  return null;
}
