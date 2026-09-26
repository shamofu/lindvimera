/** Body-only cases for both Source and Live Preview, including source tables. */
export const structureEditingCases = [
  { keys: "dah", text: "# First\nbody\n# Next\nlast", result: "# Next\nlast" },
  { keys: "dih", text: "# First\n\nbody\n\n# Next", result: "# First\n\n\n# Next" },
  { keys: "Vahd", text: "# First\nbody\n# Next", result: "# Next" },
  { keys: "daL", text: "- [ ] first\n  - child\n\n- next", result: "- next" },
  { keys: "diL", text: "- [ ] first\n  - child\n- next", result: "- [ ] \n- next" },
  { keys: "2G2daL", text: "- first\n  - child\n- next", result: "- next" },
  {
    keys: "dah",
    text: "# First\n~~~md\n# fake\n~~~\n# Next",
    result: "# Next",
  },
  {
    keys: "dah",
    text: "# First\n\n| A | B |\n| --- | --- |\n| x | y |\n\n# Next\nlast",
    result: "# Next\nlast",
  },
] as const;
