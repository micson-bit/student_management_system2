"use strict";

const form = document.querySelector("#account-form");
const title = document.querySelector("#form-title");
const description = document.querySelector("#form-description");
const nameGroup = document.querySelector("#name-group");
const nameInput = document.querySelector("#full-name");
const passwordInput = document.querySelector("#password");
const passwordLabel = document.querySelector(".label-row label");
const rememberLabel = document.querySelector("#remember-label");
const remember = document.querySelector("#remember");
const forgotButton = document.querySelector("#forgot-button");
const submitLabel = document.querySelector("#submit-label");
const termsNote = document.querySelector("#terms-note");
const switchPrompt = document.querySelector("#switch-prompt");
const toast = document.querySelector("#toast");
let mode = "signin";
let toastTimer;

function announce(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3400);
}

function updateMode(nextMode) {
  mode = nextMode;
  const signingUp = mode === "signup";

  document.querySelectorAll(".mode-tab").forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  nameGroup.classList.toggle("is-hidden", !signingUp);
  nameInput.required = signingUp;
  title.textContent = signingUp ? "Create your account" : "Welcome back";
  description.textContent = signingUp ? "Start building better attendance habits today." : "Your next class is just a sign in away.";
  passwordInput.autocomplete = signingUp ? "new-password" : "current-password";
  passwordInput.placeholder = signingUp ? "Create a password (8+ characters)" : "Enter your password";
  passwordLabel.textContent = signingUp ? "Create password" : "Password";
  rememberLabel.textContent = signingUp ? "Keep me signed in" : "Remember me";
  forgotButton.classList.toggle("is-hidden", signingUp);
  submitLabel.textContent = signingUp ? "Create your account" : "Sign in to your account";
  termsNote.classList.toggle("is-hidden", !signingUp);
  switchPrompt.innerHTML = signingUp
    ? 'Already have an account? <button class="text-button" type="button" data-mode="signin">Sign in</button>'
    : 'New to Attendly? <button class="text-button" type="button" data-mode="signup">Create an account</button>';
  clearErrors();
}

function clearErrors() {
  ["name", "email", "password"].forEach((field) => {
    document.querySelector(`#${field}-error`).textContent = "";
    const input = field === "name" ? nameInput : document.querySelector(`#${field}`);
    input.closest(".input-wrap")?.classList.remove("has-error");
    input.removeAttribute("aria-invalid");
  });
}

function setError(field, message) {
  const input = field === "name" ? nameInput : document.querySelector(`#${field}`);
  document.querySelector(`#${field}-error`).textContent = message;
  input.closest(".input-wrap").classList.add("has-error");
  input.setAttribute("aria-invalid", "true");
}

document.addEventListener("click", (event) => {
  const modeButton = event.target.closest("[data-mode]");
  if (modeButton) updateMode(modeButton.dataset.mode);
});

document.querySelectorAll('input[name="role"]').forEach((input) => {
  input.addEventListener("change", () => {
    document.querySelectorAll(".role-option").forEach((option) => {
      option.classList.toggle("is-selected", option.contains(input) && input.checked);
    });
  });
});

document.querySelector("#toggle-password").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const visible = passwordInput.type === "password";
  passwordInput.type = visible ? "text" : "password";
  button.setAttribute("aria-pressed", String(visible));
  button.setAttribute("aria-label", visible ? "Hide password" : "Show password");
});

form.addEventListener("input", (event) => {
  const field = event.target.id === "full-name" ? "name" : event.target.id;
  if (["name", "email", "password"].includes(field)) {
    document.querySelector(`#${field}-error`).textContent = "";
    event.target.closest(".input-wrap")?.classList.remove("has-error");
    event.target.removeAttribute("aria-invalid");
  }
});

forgotButton.addEventListener("click", () => {
  const email = document.querySelector("#email");
  if (!email.value.trim() || !email.validity.valid) {
    setError("email", "Enter your school email first.");
    email.focus();
    return;
  }
  announce("Password reset instructions can be sent once email delivery is connected.");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearErrors();
  const email = document.querySelector("#email");
  let firstInvalid = null;

  if (mode === "signup" && nameInput.value.trim().length < 2) {
    setError("name", "Please enter your full name.");
    firstInvalid = nameInput;
  }
  if (!email.value.trim() || !email.validity.valid) {
    setError("email", "Enter a valid school email address.");
    firstInvalid ||= email;
  }
  if (passwordInput.value.length < 8) {
    setError("password", "Use at least 8 characters.");
    firstInvalid ||= passwordInput;
  }

  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }
  const selectedRole = document.querySelector('input[name="role"]:checked').value;
  const button = document.querySelector("#submit-button");
  button.disabled = true;
  try {
    const response = await fetch(`/api/auth/${mode === "signup" ? "signup" : "login"}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ role: selectedRole, email: email.value.trim(), password: passwordInput.value, name: nameInput.value.trim() })
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 409) setError("email", result.error);
      else announce(result.error || "Could not connect to Attendly.");
      return;
    }
    window.location.href = `${result.user.role}.html`;
  } catch {
    announce("Could not reach Attendly. Start the application server and try again.");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#google-button").addEventListener("click", () => {
  announce("Google sign-in will be available when an authentication provider is connected.");
});
