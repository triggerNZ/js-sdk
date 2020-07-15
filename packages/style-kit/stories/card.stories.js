export default { title: 'Cards and Shadows' };
import { story } from 'style-loader!./card.stories.scss';

export const shadows = () => /*html*/ `
<div class="${story} shadows">
  <p>Soft Shadow (Default for Cards)</p>
  <div class="card"></div>
  <p>Hard Shadow</p>
  <div class="card hard"></div>
  <p>Dark Mode Shadow</p>
  <div class="card dark"></div>
</div>
`;

export const cards = () => /*html*/ `
<div class="${story} advanced">
  <p>Basic Card</p>
  <div class="card basic">
    <div class="content">
      <div class="icon"></div>
      <div>
        <p class="card-label">Card Label</p>
        <p class="subtitle">Sub-label (Optional)</p>
      </div>
    </div>
  </div>

  <p>Card with a Footer</p>
  <div class="card">
    <div class="content">
      <div class="icon"></div>
      <p class="card-label">Shared Card Label</p>
    </div>
    <div class="footer">
      <p class="subtitle">Some Footer Text</p>
    </div>
  </div>

  <p>Complex Footers</p>
  <div class="card complex-footer">
    <div class="content">
      <div class="icon"></div>
      <div>
        <p class="card-label">Example Complex Footer</p>
      </div>
    </div>
    <div class="footer">
      <p class="subtitle">Label</p>
      <div>
        <p>More Text</p>
        <div class="icon"></div>
      </div>
    </div>
  </div>

  <h4>Content Wrapping</h4>
  <p>Unbounded</p>
  ${largeCard()}

  <p>Bounded</p>
  <div class="fixed-width">
    ${largeCard()}
  </div>
</div>
`;

const largeCard = () => /*html*/ `
<div class="card">
  <div class="content">
    <div class="icon"></div>
    <div>
      <p class="card-label">Card Title</p>
      <p class="subtitle">
        Lorem ipsum dolor sit amet consectetur adipisicing elit.
        Aliquid velit atque odio iure dolore nihil praesentium
        delectus animi doloribus eveniet, veritatis officia adipisci
        officiis, dolorem suscipit obcaecati possimus porro nisi.
      </p>
    </div>
  </div>
</div>
`;