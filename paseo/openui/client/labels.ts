/** The few words the plugin itself shows, in the language the UI is written in. */
export function labels(rtl: boolean) {
  return rtl
    ? {
        waiting: "في انتظار ردك",
        brokenPart: "تعذّر رسم جزء من الواجهة.",
        answered: "تمت الإجابة",
        sent: "اتبعتت للـ agent",
        answerSent: "اتبعتت الإجابة",
        youAnswered: "إجابتك",
        youAnsweredOn: "إجابتك على",
        setup: "تم تفعيل OpenUI للـ agent ده",
      }
    : {
        waiting: "Waiting for you",
        brokenPart: "Part of this UI could not be drawn.",
        answered: "Answered",
        sent: "Sent to the agent",
        answerSent: "Answer sent",
        youAnswered: "You answered",
        youAnsweredOn: "You answered",
        setup: "OpenUI enabled for this agent",
      };
}
