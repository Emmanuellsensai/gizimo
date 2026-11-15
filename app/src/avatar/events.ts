// Names of the messages the main window sends to the floating avatar window.
export const EV_LEVEL = "avatar:level"; // { level: number, speaking: boolean } about 25 times a second while talking
export const EV_CHARACTER = "avatar:character"; // { id: string } which character the avatar should show
export const EV_HELLO = "avatar:hello"; // the floating window asks the main window which character is active
