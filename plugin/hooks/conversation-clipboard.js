/** POSIX shell quoting keeps the CSV path one argument, including embedded quotes. */
export function visidataCommand(path) {
  return `vd '${path.replaceAll("'", "'\\''")}'`
}

/** The callback is provided by the calling hook; this module receives no mods API object. */
export function visidataButton({ Button, file, index, copy }) {
  return h(Button, { key: `visidata-${index}`, label: 'VisiData', onPress: press => copy(file, press.surface) })
}
