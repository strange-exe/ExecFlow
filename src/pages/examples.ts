// The example programs on the guide pages (flowchart-from-code.html, python.html, c.html, cpp.html).
// Each one's code is src/pages/examples/<id>.<ext>, the input typed into it <id>.stdin (when it reads
// any), and what it printed in the real app is in captured.json, written by the capture run
// (.claude/verify/pages/build/capture.spec.ts), never by hand. `name` is the file name the example
// gets in the editor when its "Open in ExecFlow" link is opened.

export interface Example {
  /** The file name in the editor (and in a Python traceback). */
  name: string;
  /** For a flowchart example: the function the chart is drawn for ("Program" is a Python file's top level). */
  chart?: string;
}

export const EXAMPLES: Readonly<Record<string, Example>> = {
  // /flowchart-from-code
  "fc-loop": { name: "sum_loop.py", chart: "Program" },
  "fc-ifelse": { name: "pass_fail.c", chart: "main" },
  "fc-return": { name: "find.py", chart: "find" },
  "fc-nested": { name: "table.cpp", chart: "main" },
  // /python
  "py-input": { name: "greet.py" },
  "py-list": { name: "marks.py" },
  "py-function": { name: "primes.py" },
  "py-error": { name: "next_year.py" },
  "py-indent": { name: "hot_day.py" },
  "py-name": { name: "total.py" },
  "py-numpy": { name: "heights.py" },
  "py-version": { name: "which_python.py" },
  "py-net": { name: "fetch_page.py" },
  "py-thread": { name: "threads.py" },
  "py-pip": { name: "use_requests.py" },
  "py-tkinter": { name: "window.py" },
  "py-forever": { name: "forever.py" },
  // /c
  "c-scanf": { name: "add.c" },
  "c-array": { name: "temps.c" },
  "c-pointer": { name: "swap.c" },
  "c-semicolon": { name: "semicolon.c" },
  "c-undeclared": { name: "total.c" },
  "c-amp": { name: "age.c" },
  "c-crash": { name: "crash.c" },
  "c-version": { name: "which_c.c" },
  // /cpp
  "cpp-cin": { name: "birth_year.cpp" },
  "cpp-vector": { name: "scores.cpp" },
  "cpp-string": { name: "word.cpp" },
  "cpp-std": { name: "hello.cpp" },
  "cpp-args": { name: "greet.cpp" },
  "cpp-push": { name: "marks.cpp" },
  "cpp-version": { name: "which_cpp.cpp" },
  "cpp-bits": { name: "all_headers.cpp" },
  // /loop-flowcharts
  "lp-for-c": { name: "times_table.c", chart: "main" },
  "lp-for-py": { name: "times_table.py", chart: "Program" },
  "lp-while-c": { name: "digit_sum.c", chart: "main" },
  "lp-while-py": { name: "digit_sum.py", chart: "Program" },
  "lp-do-c": { name: "pick_number.c", chart: "main" },
  "lp-do-py": { name: "pick_number.py", chart: "Program" },
  "lp-nested-c": { name: "stars.c", chart: "main" },
  "lp-nested-py": { name: "stars.py", chart: "Program" },
  "lp-jump-c": { name: "positive_sum.c", chart: "main" },
  "lp-jump-py": { name: "positive_sum.py", chart: "Program" },
  "lp-off-c": { name: "count_to_ten.c" },
  "lp-off-py": { name: "count_to_ten.py" },
  "lp-endless-c": { name: "forgot_update.c" },
  "lp-endless-py": { name: "forgot_update.py" },
  "lp-change-c": { name: "skip_ahead.c" },
  "lp-change-py": { name: "skip_ahead.py" },
};

/** The extension of an example's source file (its editor name's). */
export const extOf = (id: string): string => EXAMPLES[id].name.slice(EXAMPLES[id].name.lastIndexOf("."));
