import { NextRequest } from "next/server";
import { Message as VercelChatMessage, StreamingTextResponse } from "ai";
// import { OpenAIEmbeddings } from "langchain/embeddings/openai";

import { ChatOpenAI } from "langchain/chat_models/openai";
import { BytesOutputParser,StringOutputParser } from "langchain/schema/output_parser";
import { PromptTemplate } from "langchain/prompts";
import { RunnableSequence, RunnablePassthrough } from "langchain/schema/runnable";

import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { createClient } from "@supabase/supabase-js";
import { SupabaseVectorStore } from "langchain/vectorstores/supabase";



// import { RetrievalQAChain, LLMChain,ConversationalRetrievalQAChain } from "langchain/chains";
import { ConversationSummaryBufferMemory } from "langchain/memory";

type ConversationalRetrievalQAChainInput = {
  question: string;
  chat_history: VercelChatMessage[];
};

export const runtime = "edge";

/**
 * Basic memory formatter that stringifies and passes
 * message history directly into the model.
 */
//  Format message is used to get previous message fro, Vercel Chat History
const formatMessage = (message: VercelChatMessage) => {
  return `${message.role}: ${message.content}`;
};

// This is used to add previous messages to the chat history.
const formatVercelMessages = (chatHistory: VercelChatMessage[]) => {
  const formattedDialogueTurns = chatHistory.map((message) => {
    if (message.role === "user") {
      return `Human: ${message.content}`;
    } else if (message.role === "assistant") {
      return `Assistant: ${message.content}`;
    } else {
      return `${message.role}: ${message.content}`;
    }
  });
  return formattedDialogueTurns.join("\n");
};


// Connecting to client to retrieve data from Supabase. (!! NOT UPLAOAD ONLY RETRIEVE!)

// const retriever = vectorstore.asRetriever();

// if (retriever){
//   console.log('\n\nRetriever is ready\n\n');
// }else
// {
//   console.log("\n\nretr`iever is not ready]\n\n");
// }


//  CREATES TEMPLATE FOR THE CHAT

// #1
const TEMPLATE = `You are a Hotel Receptionist bot of "Four Points by Sheraton" hotel. All answers should be simple and straight to the point. Behave humanely to the customers
 
Current conversation:
{chat_history}
 
User: {input}
AI:`;

const prompt = PromptTemplate.fromTemplate(TEMPLATE);

// #2

// An initial context should be provided to the model to help it understand the conversation so far.
const CONDENSE_QUESTION_TEMPLATE = `Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question, in its original language.

Chat History:
{chat_history}
Follow Up Input: {question}
Standalone question:`;

const condenseQuestionPrompt = PromptTemplate.fromTemplate(
  CONDENSE_QUESTION_TEMPLATE,
);


// #3
const ANSWER_TEMPLATE = `You are a Hotel Receptionist at "Four Points by Sheraton" hotel.

You will be given the context of the chat so far followed by customer's question.
The answer should be short, straight and to the point.
Answer the question based only on the following context:
{context}

Question: {question}
`;
const answerPrompt = PromptTemplate.fromTemplate(ANSWER_TEMPLATE);



/*
  This handler initializes and calls a simple chain with a prompt,
  chat model, and output parser. See the docs for more information:
 
  https://js.langchain.com/docs/guides/expression_language/cookbook#prompttemplate--llm--outputparser
 */


console.log("we are outside Route");

export async function POST(req: NextRequest) {


  console.log("we are inside Route");

  const body = await req.json();
  const messages = body.messages ?? [];
  const formattedPreviousMessages = messages.slice(0, -1).map(formatMessage);
  const currentMessageContent = messages[messages.length - 1].content;



    /* create vectorstore*/
    // const vectorStore = await SupabaseVectorStore.fromExistingIndex(
    //   supabaseClient,
    //   new OpenAIEmbeddings(),
    // );


  /**
   * See a full list of supported models at:
   * https://js.langchain.com/docs/modules/model_io/models/
   */


  // *____________CREATING CLIENT (SUPABASE) AND CALLING IN THE MODEL__________

  const model = new ChatOpenAI({
    temperature: 0.8,
    modelName: "gpt-3.5-turbo",
    stop: undefined,
  });

  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PRIVATE_KEY!
  );
  
  const vectorstore = new SupabaseVectorStore(new OpenAIEmbeddings(), {
    client,
    tableName: "documents",
    queryName: "match_documents",
  });

  const retriever = vectorstore.asRetriever();

 // *____________HANDLE MEMORY AND PLAT WITH CHAINS__________


  const memory = new ConversationSummaryBufferMemory({
    llm: model, 
    memoryKey: "chat_history", 
    inputKey: "question", 
    outputKey: "answer", 
    maxTokenLimit: 650, 
    returnMessages: true});

/*

 *____ ITS NOT WORKING AS PER OUR NEEDS CURRENTLY ____
 TODO : Need to add LLMCHAIN and check
 TODO : Also check for how to add retriever to Runnable Sequence
 TODO : Check the issue in GITHUB
 *_________________________________________________________

  const convo = ConversationalRetrievalQAChain.fromLLM(model, vectorstore.asRetriever(), { 
    outputKey: "Answer",
    qaChainOptions: {
      type: "stuff",
    },
    memory,
  });
  const outputParser = new BytesOutputParser();
  const chain = RunnableSequence.from([prompt, model, outputParser]);

    const stream = await chain.stream({
    chat_history: formattedPreviousMessages.join("\n"),
    input: currentMessageContent,
  });

*/
// console.log(ConversationSummaryBufferMemory);

  const standaloneQuestionChain = RunnableSequence.from([
    {
      question: (input: ConversationalRetrievalQAChainInput) =>
        input.question,
      chat_history: (input: ConversationalRetrievalQAChainInput) =>
            memory
        // formatVercelMessages(input.chat_history),
    },
    condenseQuestionPrompt,
    model,
    new StringOutputParser(),
  ]);

  
  const answerChain = RunnableSequence.from([
    {
      context: retriever,
      question: new RunnablePassthrough(),
    },
    answerPrompt,
    model,
  
    new BytesOutputParser(),
  ]);

  const conversationalRetrievalQAChain =
  standaloneQuestionChain.pipe(answerChain);

  const stream = await conversationalRetrievalQAChain.stream({
    question: currentMessageContent,
    chat_history: formattedPreviousMessages.join("\n"),
  });







  console.log("::::::: THE END :::::::\n\n" )
  // const chain = prompt.pipe(model).pipe(outputParser);



  return new StreamingTextResponse(stream);
}
