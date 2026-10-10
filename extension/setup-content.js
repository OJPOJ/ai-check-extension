// Texts of the setup page (setup.js), kept apart from the logic.

// Written for this page (no dataset, no third-party license). About 130 words each, so the "short text"
// rule does not apply. The second imitates typical chatbot style.
const SAMPLES = [
  {
    id: "human",
    label: "Sample A – written by a person",
    text:
      "Last Tuesday the bus broke down halfway to my sister's place, so I walked the rest, about forty minutes " +
      "along the canal in shoes that were definitely not made for it. Somewhere near the old brickworks a man was " +
      "fishing with what looked like a broom handle, and we ended up talking for a good quarter of an hour about " +
      "nothing in particular: his dog, the price of bait, why the swans never leave. I was late, obviously. My " +
      "sister had already started on the soup and pulled a face when I came in, blistered and grinning. Honestly, " +
      "I can't say it was a better day than if the bus had worked. But I remember it, and I couldn't tell you a " +
      "single thing about the Tuesday before, or the one after, or most of that whole autumn if I'm being straight."
  },
  {
    id: "ai",
    label: "Sample B – chatbot style",
    text:
      "Time management is an essential skill that can significantly improve both your personal and professional " +
      "life. By implementing a few simple strategies, you can enhance your productivity and achieve your goals more " +
      "effectively. First, it is important to prioritize your tasks based on urgency and importance. Second, " +
      "setting clear, measurable goals provides direction and motivation. Additionally, minimizing distractions, " +
      "such as social media notifications, allows you to maintain focus. Furthermore, taking regular breaks helps " +
      "prevent burnout and ensures sustained performance. In conclusion, effective time management is not about " +
      "doing more things; it is about doing the right things at the right time. By consistently applying these " +
      "principles, you can unlock your full potential and lead a more balanced, fulfilling life. Ultimately, the key " +
      "to success lies in consistency, discipline, and a willingness to adapt your approach as your needs evolve " +
      "over time, ensuring long-term growth and lasting satisfaction."
  }
];

const SCAN_MODES = [
  {
    value: "manual",
    title: "Only on button press",
    text: "Nothing is looked at until you press \"Scan page now\" in the popup or use the right-click menu. Most private."
  },
  {
    value: "sites",
    title: "Only on sites I choose",
    text: "Pages are scanned automatically only on sites you switch on yourself in the popup. Everywhere else, nothing happens."
  },
  {
    value: "all",
    title: "On all sites",
    text: "Every page you open is scanned automatically (except the blocklist). Paragraph text is still processed only by the " +
      "model you chose – with a browser model it stays on this computer."
  }
];

// "Quick start" step: how to scan, depending on the chosen scan mode
const HOW_SCAN = {
  all: "Open an article",
  sites: "Open a site you want checked, click the icon and switch on \"Scan this site automatically\"",
  manual: "Open an article, click the icon and press \"Scan page now\""
};
