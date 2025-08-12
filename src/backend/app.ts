import * as express from 'express';
import * as cors from 'cors';
import helmet from 'helmet';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());