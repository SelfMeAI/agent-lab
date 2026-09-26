/** Kimi 2.1.1: add the missing Other arm at the ACP form boundary only. */
function selfmeKimiOtherValue(question) {
  let value = "__selfme_kimi_other__";
  while (question.options.some(option => option.label === value)) value += "_";
  return value;
}

function selfmeExtendKimiQuestionForm(form, questions) {
  const fields = questions.map((question, index) => {
    const id = `q${index}`, fieldId = `${id}_other`, value = selfmeKimiOtherValue(question);
    const field = form.requestedSchema.properties[id];
    const options = question.multiSelect === true ? field.items.anyOf : field.oneOf;
    options.push({ const: value, title: question.otherLabel ?? "Other", description: question.otherDescription });
    // Keep the enum valid: Other is a real enum value with a separate,
    // optional string field. The desktop renders both as one Other choice.
    form.requestedSchema.properties[fieldId] = {
      type: "string", title: question.otherLabel ?? "Other",
      description: question.otherDescription, maxLength: 8000,
    };
    return { id, fieldId, value };
  });
  form._meta = { ...form._meta, selfmeKimiOther: { version: 1, fields } };
  return form;
}

function selfmeExtendKimiQuestionAnswers(nativeAnswers, questions, response) {
  if (response.action !== "accept" || !response.content) return null;
  const answers = nativeAnswers ?? {};
  questions.forEach((question, index) => {
    const id = `q${index}`, value = response.content[id], custom = response.content[`${id}_other`];
    const selected = question.multiSelect === true
      ? Array.isArray(value) && value.includes(selfmeKimiOtherValue(question))
      : value === selfmeKimiOtherValue(question);
    if (!selected || typeof custom !== "string" || !custom.trim() || custom.length > 8000) return;
    // Match native multi-select encoding: declared choices, then Other text.
    answers[question.question] = answers[question.question]
      ? `${answers[question.question]}, ${custom.trim()}` : custom.trim();
  });
  return Object.keys(answers).length ? answers : null;
}

// Share exactly the same functions with tests; inject into the bundled module
// in memory, without changing installed upstream files or its interaction loop.
export const kimiQuestionBridgeSource = [selfmeKimiOtherValue, selfmeExtendKimiQuestionForm, selfmeExtendKimiQuestionAnswers]
  .map(fn => fn.toString()).join("\n") + `
function questionRequestToElicitationParams(questions, sessionId, toolCallId) {
  return selfmeExtendKimiQuestionForm(selfmeOriginalKimiQuestionForm(questions, sessionId, toolCallId), questions);
}
function elicitationResponseToQuestionAnswers(questions, response) {
  return selfmeExtendKimiQuestionAnswers(selfmeOriginalKimiQuestionAnswers(questions, response), questions, response);
}
`;
